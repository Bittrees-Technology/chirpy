// Self-hosted only. Never import this module into a browser or Vercel handler.
import { DatabaseSync } from 'node:sqlite';
import {RECOVERY_QUARANTINE} from './inbound-state-lock.js';
import { mkdirSync,lstatSync,openSync,closeSync,constants } from 'node:fs';
import { join,isAbsolute } from 'node:path';
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const scopeFields=['eventId','contentHash','recipientHash','textHash'];
function validScope(scope){return scope&&Object.keys(scope).length===4&&scopeFields.every(k=>Object.hasOwn(scope,k)&&hex(scope[k]));}
function privateDirectory(directory){try{lstatSync(join(directory,RECOVERY_QUARANTINE));throw Error('Recovery copy is quarantined');}catch(error){if(error.code!=='ENOENT')throw error;}if(!isAbsolute(directory))throw Error('Absolute bridge directory required');const s=lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077))throw Error('Private bridge directory required');}
function existingFile(path){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw Error('Private bridge journal required');}
export class InboundSendJournal {
  #db;#identity;
  // Provision only a new dedicated directory. An existing SDK directory must
  // never acquire a blank journal that hides its pending publication intents.
  static provision(directory,identityHash){
    if(!isAbsolute(directory)||!hex(identityHash))throw Error('Invalid bridge identity');
    mkdirSync(directory,{mode:0o700});
    const path=join(directory,'send-journal.sqlite');const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);
    const db=new DatabaseSync(path);
    try{db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA user_version=2;
CREATE TABLE launches(event TEXT PRIMARY KEY);
CREATE TABLE bridge(id INTEGER PRIMARY KEY CHECK(id=1),identity_hash TEXT NOT NULL,active_event TEXT);
CREATE TABLE attempts(event TEXT PRIMARY KEY,content_hash TEXT NOT NULL,recipient_hash TEXT NOT NULL,text_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('armed','published')),created INTEGER NOT NULL,receipt TEXT);
`);db.prepare('INSERT INTO bridge VALUES(1,?,NULL)').run(identityHash);}finally{db.close();}
    return new InboundSendJournal(directory,identityHash);
  }
  constructor(directory,identityHash){
    if(!hex(identityHash))throw Error('Invalid bridge identity');privateDirectory(directory);
    const path=join(directory,'send-journal.sqlite');existingFile(path);
    this.#db=new DatabaseSync(path,{open:true});this.#identity=identityHash;
    try{
      this.#db.exec('PRAGMA synchronous=FULL;PRAGMA busy_timeout=3000');
      if(![1,2].includes(this.#db.prepare('PRAGMA user_version').get().user_version)||this.#db.prepare('SELECT identity_hash FROM bridge WHERE id=1').get()?.identity_hash!==identityHash)throw Error('Bridge journal identity mismatch');
      if(this.#db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Bridge journal integrity unavailable');
      this.#consistent();
      // Legacy armed attempts may already have opened the SDK. Never grant a
      // new launch to them while adding the child-side claim table.
      this.#transaction(()=>{
        if(this.#db.prepare('PRAGMA user_version').get().user_version===1){
          this.#db.exec("CREATE TABLE launches(event TEXT PRIMARY KEY);INSERT INTO launches SELECT event FROM attempts;PRAGMA user_version=2;");
        }
      });
    }catch(error){this.#db.close();throw error;}
  }
  #consistent(){
    const bridge=this.#db.prepare('SELECT * FROM bridge WHERE id=1').get();
    const armed=this.#db.prepare("SELECT event FROM attempts WHERE state='armed'").all();
    if(bridge?.identity_hash!==this.#identity||armed.length>1||(armed[0]?.event||null)!==bridge.active_event)throw Error('Bridge journal guard is inconsistent');
    return bridge;
  }
  #transaction(fn){this.#db.exec('BEGIN IMMEDIATE');try{const result=fn();this.#db.exec('COMMIT');return result;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
  inspect(){const bridge=this.#consistent();return {blocked:bridge.active_event!==null,eventId:bridge.active_event};}
  assertIdentity(expected){if(expected!==this.#identity)throw Error('Bridge journal identity mismatch');}
  outcome(eventId,contentHash){
    if(!hex(eventId)||!hex(contentHash))throw Error('Invalid outcome scope');
    this.#consistent();
    const attempt=this.#db.prepare('SELECT * FROM attempts WHERE event=?').get(eventId);
    if(!attempt)return {status:'missing'};
    if(attempt.content_hash!==contentHash)throw Error('Outcome scope mismatch');
    return attempt.state==='published'?{status:'published',receipt:JSON.parse(attempt.receipt)}:{status:'uncertain'};
  }
  begin(scope){
    if(!validScope(scope))throw Error('Invalid send scope');
    return this.#transaction(()=>{
      const bridge=this.#consistent(),old=this.#db.prepare('SELECT * FROM attempts WHERE event=?').get(scope.eventId);
      if(old){
        if(old.content_hash!==scope.contentHash||old.recipient_hash!==scope.recipientHash||old.text_hash!==scope.textHash)throw Error('Send scope cannot change');
        return old.state==='published'?{status:'published',receipt:JSON.parse(old.receipt)}:{status:'uncertain'};
      }
      if(bridge.active_event!==null)return {status:'blocked'};
      this.#db.prepare("INSERT INTO attempts VALUES(?,?,?,?,'armed',?,NULL)").run(scope.eventId,scope.contentHash,scope.recipientHash,scope.textHash,Date.now());
      this.#db.prepare('UPDATE bridge SET active_event=? WHERE id=1').run(scope.eventId);
      return {status:'armed'};
    });
  }
  claimLaunch(scope,identityHash){
    if(!validScope(scope)||identityHash!==this.#identity)throw Error('Invalid launch scope or identity');
    return this.#transaction(()=>{
      const bridge=this.#consistent(),attempt=this.#db.prepare('SELECT * FROM attempts WHERE event=?').get(scope.eventId);
      if(!attempt||attempt.content_hash!==scope.contentHash||attempt.recipient_hash!==scope.recipientHash||attempt.text_hash!==scope.textHash)throw Error('Launch scope mismatch');
      if(attempt.state!=='armed'||bridge.active_event!==scope.eventId)return false;
      return this.#db.prepare('INSERT OR IGNORE INTO launches VALUES(?)').run(scope.eventId).changes===1;
    });
  }
  // Caller must already have verified the exact published SDK message against
  // this scope. This validates/stores that receipt; it is not an SDK verifier.
  recordPublished(scope,receipt){
    if(!validScope(scope)||!receipt||Object.keys(receipt).length!==4||!['messageId','conversationId','senderInboxId','textHash'].every(k=>Object.hasOwn(receipt,k))||!hex(receipt.messageId)||typeof receipt.conversationId!=='string'||!/^[a-f0-9]{32,64}$/.test(receipt.conversationId)||!hex(receipt.senderInboxId)||receipt.textHash!==scope.textHash)throw Error('Invalid publication receipt');
    return this.#transaction(()=>{
      const bridge=this.#consistent(),old=this.#db.prepare('SELECT * FROM attempts WHERE event=?').get(scope.eventId);
      if(!old||old.content_hash!==scope.contentHash||old.recipient_hash!==scope.recipientHash||old.text_hash!==scope.textHash)throw Error('Publication scope mismatch');
      const encoded=JSON.stringify({messageId:receipt.messageId,conversationId:receipt.conversationId,senderInboxId:receipt.senderInboxId,textHash:receipt.textHash});
      if(old.state==='published'){if(old.receipt!==encoded)throw Error('Publication receipt cannot change');return;}
      if(bridge.active_event!==scope.eventId)throw Error('Publication guard mismatch');
      this.#db.prepare("UPDATE attempts SET state='published',receipt=? WHERE event=?").run(encoded,scope.eventId);
      this.#db.prepare('UPDATE bridge SET active_event=NULL WHERE id=1').run();
    });
  }
  close(){this.#db.close();}
}

// The callback may initialize/use the SDK only once a durable guard exists.
// Never clear it in catch/finally, on lease expiry, or when authority is revoked.
export async function guardedInboundSend(journal,scope,publishAndVerify){
  const reservation=journal.begin(scope);
  if(reservation.status!=='armed')return reservation;
  try{
    const receipt=await publishAndVerify();
    journal.recordPublished(scope,receipt);
    return {status:'published',receipt};
  }catch{return {status:'uncertain'};}
}
