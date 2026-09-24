import {DatabaseSync} from 'node:sqlite';
import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {openSync,closeSync,lstatSync} from 'node:fs';
import {isAbsolute,dirname} from 'node:path';
import {normalizeMailAddress} from '../packages/core/src/mailAuth.js';

const states=new Set(['uncertain','accepted','rejected','retryable']);
const maxLifetime=82800000;
const fail=()=>{throw Error('Invalid SMTP journal configuration or state');};
function secret(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail();return Buffer.from(value,'hex');}
const mac=(key,purpose,value)=>createHmac('sha256',key).update(purpose+'\0'+value).digest('hex');
function privateFile(filename){
 if(!isAbsolute(filename))fail();
 const parent=lstatSync(dirname(filename)),file=lstatSync(filename);
 if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077||!file.isFile()||file.isSymbolicLink()||file.mode&0o077)fail();
 if(process.getuid&&(parent.uid!==process.getuid()||file.uid!==process.getuid()))fail();
 return file;
}
function configure(db){db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');}
export function initializeSmtpJournal({filename,key:rawKey}){
 const key=secret(rawKey);
 if(!isAbsolute(filename))fail();
 const parent=lstatSync(dirname(filename));
 if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077||process.getuid&&parent.uid!==process.getuid())fail();
 // Initialization is a separate operator action and never replaces an old ledger.
 const fd=openSync(filename,'wx',0o600);closeSync(fd);privateFile(filename);
 const db=new DatabaseSync(filename);const journalId=randomUUID();
 try{
  configure(db);
  db.exec('BEGIN IMMEDIATE; CREATE TABLE metadata(version INTEGER NOT NULL,journal_id TEXT NOT NULL,key_check TEXT NOT NULL); CREATE TABLE submissions(request_key TEXT PRIMARY KEY,digest TEXT NOT NULL,deadline INTEGER NOT NULL,receipt_id TEXT UNIQUE NOT NULL,state TEXT NOT NULL CHECK(state IN (\'uncertain\',\'accepted\',\'rejected\',\'retryable\')),attempt TEXT NOT NULL,attempts INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL)');
  db.exec('CREATE INDEX smtp_pending ON submissions(state,receipt_id)');
  db.prepare('INSERT INTO metadata VALUES(1,?,?)').run(journalId,mac(key,'key-check',journalId));db.exec('COMMIT');
  return {version:1,journalId};
 }finally{db.close();key.fill(0);}
}
function scope(key,command){
 if(!command||Object.keys(command).sort().join(',')!=='deadline,payload,requestId'||typeof command.requestId!=='string'||!/^chirpy-mail\/[a-f0-9]{64}\/0x[a-f0-9]{40}\/[a-f0-9]{32}$/.test(command.requestId)||!Number.isSafeInteger(command.deadline)||command.deadline<=0)fail();
 const p=command.payload;
 if(!p||Object.keys(p).sort().join(',')!=='from,headers,subject,text,to'||normalizeMailAddress(p.from)!==p.from||!p.from||!Array.isArray(p.to)||p.to.length!==1||normalizeMailAddress(p.to[0])!==p.to[0]||!p.to[0]||
 typeof p.subject!=='string'||!p.subject.trim()||p.subject.length>120||/[\x00-\x1f\x7f]/.test(p.subject)||typeof p.text!=='string'||!p.text.trim()||Buffer.byteLength(p.text)>24576||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(p.text)||
 !p.headers||Object.keys(p.headers).join(',')!=='X-Chat-Bridge'||p.headers['X-Chat-Bridge']!=='wallet-to-email')fail();
 const payload={from:p.from,to:[p.to[0]],subject:p.subject,text:p.text,headers:{'X-Chat-Bridge':'wallet-to-email'}};
 return {requestKey:mac(key,'request',command.requestId),digest:mac(key,'scope',JSON.stringify([command.requestId,command.deadline,payload])),deadline:command.deadline,payload};
}
function projection(row){
 if(!row||!states.has(row.state)||!/^smtp_[a-f0-9]{32}$/.test(row.receipt_id)||!Number.isSafeInteger(row.attempts)||row.attempts<1||row.attempts>5||row.state==='retryable'&&row.attempts===5)fail();
 return {status:row.state,id:row.receipt_id,attempts:row.attempts};
}
export function openSmtpJournal({filename,key:rawKey,journalId,now=Date.now}){
 const key=secret(rawKey);const identity=privateFile(filename); // Missing state fails; never implicitly initialize.
 if(typeof journalId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(journalId))fail();
 const db=new DatabaseSync(filename);let closed=false;
 try{
  configure(db);
  const rows=db.prepare('SELECT * FROM metadata').all();
  if(rows.length!==1||rows[0].version!==1||rows[0].journal_id!==journalId||typeof rows[0].key_check!=='string'||!/^[a-f0-9]{64}$/.test(rows[0].key_check)||!timingSafeEqual(Buffer.from(rows[0].key_check,'hex'),Buffer.from(mac(key,'key-check',journalId),'hex')))fail();
  db.prepare('SELECT request_key,digest,deadline,receipt_id,state,attempt,attempts,created,updated FROM submissions LIMIT 0').all();
 }catch(error){db.close();key.fill(0);throw error;}
 function live(){if(closed)fail();const file=privateFile(filename);if(file.dev!==identity.dev||file.ino!==identity.ino)fail();}
 function read(s){live();const row=db.prepare('SELECT * FROM submissions WHERE request_key=?').get(s.requestKey);if(row&&(row.digest!==s.digest||row.deadline!==s.deadline))throw Error('SMTP request conflicts with its original scope');if(row)projection(row);return row;}
 return {
  check(){live();},
  summary(){
   live();const time=now();
   const row=db.prepare("SELECT COUNT(*) AS count,MIN(updated) AS oldest,MAX(updated) AS latest,SUM(CASE WHEN updated<=? THEN 1 ELSE 0 END) AS stale,MIN(attempts) AS firstAttempt,MAX(attempts) AS lastAttempt,MIN(updated-created) AS elapsed FROM submissions WHERE state='uncertain'").get(time-60000);
   if(!Number.isSafeInteger(time)||time<=0||!Number.isSafeInteger(row.count)||row.count<0||row.count>0&&(!Number.isSafeInteger(row.oldest)||row.oldest<=0||!Number.isSafeInteger(row.latest)||row.latest>time||!Number.isSafeInteger(row.firstAttempt)||!Number.isSafeInteger(row.lastAttempt)||row.firstAttempt<1||row.lastAttempt>5||row.elapsed<0))fail();
   return {uncertainCount:row.count,staleUncertainCount:row.stale||0,oldestUncertainAt:row.count?row.oldest:null};
  },
  pending({after=null,limit=25}={}){
   live();if(after!==null&&(typeof after!=='string'||!/^smtp_[a-f0-9]{32}$/.test(after))||!Number.isSafeInteger(limit)||limit<1||limit>50)fail();
   const rows=db.prepare("SELECT * FROM submissions WHERE state='uncertain' AND receipt_id>? ORDER BY receipt_id LIMIT ?").all(after||'',limit+1);
   const page=rows.slice(0,limit).map(row=>{const p=projection(row);if(!Number.isSafeInteger(row.created)||row.created<=0||!Number.isSafeInteger(row.updated)||row.updated<row.created)fail();return {...p,createdAt:row.created,updatedAt:row.updated};});
   return {items:page,nextCursor:rows.length>limit?page.at(-1).id:null};
  },
  reference(command){live();const s=scope(key,command);return {requestId:command.requestId,deadline:s.deadline,digest:s.digest};},
  recover(reference){
   if(!reference||Object.keys(reference).sort().join(',')!=='deadline,digest,requestId'||typeof reference.requestId!=='string'||!/^chirpy-mail\/[a-f0-9]{64}\/0x[a-f0-9]{40}\/[a-f0-9]{32}$/.test(reference.requestId)||!Number.isSafeInteger(reference.deadline)||reference.deadline<=0||typeof reference.digest!=='string'||!/^[a-f0-9]{64}$/.test(reference.digest))fail();
   const row=read({requestKey:mac(key,'request',reference.requestId),digest:reference.digest,deadline:reference.deadline});return row?projection(row):{status:'unknown'};
  },
  inspect(command){const row=read(scope(key,command));return row?projection(row):{status:'unknown'};},
  async submit(command,{authorize,send,signal}={}){
   if(typeof authorize!=='function'||typeof send!=='function')fail();
   const s=scope(key,command);let row=read(s);
   // Recover known outcomes before checking current consent: no new SMTP send occurs.
   if(row&&row.state!=='retryable')return projection(row);
   let time=now();if(!Number.isSafeInteger(time)||time<=0)fail();
   if(s.deadline<=time)return {status:'expired'};
   if(s.deadline>time+maxLifetime)fail();
   signal?.throwIfAborted();
   const authorized=await authorize();
   // Another worker may have submitted while this authority check was pending.
   row=read(s);if(row&&row.state!=='retryable')return projection(row);
   if(authorized!==true)return {status:'denied'};
   signal?.throwIfAborted();live();time=now();
   if(!Number.isSafeInteger(time)||time<=0)fail();
   if(s.deadline<=time)return {status:'expired'};
   if(s.deadline>time+maxLifetime)fail();
   const attempt=randomUUID();let claimed=false;
   db.exec('BEGIN IMMEDIATE');
   try{
    row=read(s);
    if(!row){
     db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?)').run(s.requestKey,s.digest,s.deadline,'smtp_'+randomBytes(16).toString('hex'),'uncertain',attempt,1,time,time);claimed=true;
    }else if(row.state==='retryable'&&row.attempts<5){
     db.prepare("UPDATE submissions SET state='uncertain',attempt=?,attempts=attempts+1,updated=? WHERE request_key=?").run(attempt,time,s.requestKey);claimed=true;
    }
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   row=read(s);
   if(!claimed)return projection(row);
   // The durable uncertain row MUST precede the first potentially accepting SMTP operation.
   let outcome='uncertain';
   try{
    signal?.throwIfAborted();
    const result=await send({...s.payload,messageId:`<${row.receipt_id}@${s.payload.from.split('@')[1]}>`});
    if(result&&Object.keys(result).sort().join(',')==='status'&&result.status==='accepted')outcome='accepted';
    else if(result&&Object.keys(result).sort().join(',')==='definitiveNoAcceptance,status'&&result.definitiveNoAcceptance===true&&['rejected','retryable'].includes(result.status))outcome=result.status;
   }catch{/* Timeout, disconnect, cancellation and malformed acknowledgements never permit another send. */}
   if(outcome==='retryable'&&row.attempts>=5)outcome='rejected';
   live();
   const finished=now();if(!Number.isSafeInteger(finished)||finished<=0)fail();
   const changed=db.prepare('UPDATE submissions SET state=?,updated=? WHERE request_key=? AND attempt=? AND state=\'uncertain\'').run(outcome,Math.max(time,finished),s.requestKey,attempt);
   if(changed.changes!==1)fail();
   return projection(read(s));
  },
  close(){if(!closed){closed=true;db.close();key.fill(0);}},
 };
}
