import {afterEach,it,expect} from 'vitest';
import {mkdtempSync,rmSync,mkdirSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {InboundSendJournal,guardedInboundSend} from '../inbound-send-journal.js';
const roots:string[]=[];const journals:any[]=[];
const identity='ab'.repeat(32),scope={eventId:'12'.repeat(32),contentHash:'34'.repeat(32),recipientHash:'56'.repeat(32),textHash:'78'.repeat(32)};
const receipt={messageId:'9a'.repeat(32),conversationId:'bc'.repeat(16),senderInboxId:'de'.repeat(32),textHash:scope.textHash};
function root(){const p=mkdtempSync(join(tmpdir(),'chat-journal-'));roots.push(p);return join(p,'bridge');}
function provision(){const dir=root(),journal=InboundSendJournal.provision(dir,identity);journals.push(journal);return {dir,journal};}
afterEach(()=>{for(const j of journals.splice(0))try{j.close();}catch{};for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
it('requires a private existing journal and never silently provisions an SDK directory',()=>{
 const dir=root();expect(()=>new InboundSendJournal(dir,identity)).toThrow();mkdirSync(dir,{mode:0o700});expect(()=>InboundSendJournal.provision(dir,identity)).toThrow();expect(()=>new InboundSendJournal(dir,identity)).toThrow();
});
it('persists a guard before callback entry and stores one immutable publication receipt',async()=>{
 const {dir,journal}=provision();let sends=0;
 const result=await guardedInboundSend(journal,scope,async()=>{sends++;const other=new InboundSendJournal(dir,identity);expect(other.inspect()).toEqual({blocked:true,eventId:scope.eventId});other.close();return receipt;});
 expect(result.status).toBe('published');expect(journal.inspect().blocked).toBe(false);
 expect((await guardedInboundSend(journal,scope,async()=>{sends++;return receipt;})).status).toBe('published');expect(sends).toBe(1);
 expect(()=>journal.recordPublished(scope,{...receipt,messageId:'ff'.repeat(32)})).toThrow();
});
it('uncertain failures block retries and all other events across process restart',async()=>{
 const {dir,journal}=provision();let sends=0;
 expect((await guardedInboundSend(journal,scope,async()=>{sends++;throw Error('ack lost');})).status).toBe('uncertain');
 journal.close();const reopened=new InboundSendJournal(dir,identity);journals.push(reopened);
 expect((await guardedInboundSend(reopened,scope,async()=>{sends++;return receipt;})).status).toBe('uncertain');
 expect((await guardedInboundSend(reopened,{...scope,eventId:'ef'.repeat(32)},async()=>{sends++;return receipt;})).status).toBe('blocked');expect(sends).toBe(1);
});
it('concurrent instances allow only one SDK callback',async()=>{
 const {dir,journal}=provision();const other=new InboundSendJournal(dir,identity);journals.push(other);let sends=0;
 const callback=async()=>{sends++;await new Promise(r=>setTimeout(r,10));return receipt;};
 const results=await Promise.all([guardedInboundSend(journal,scope,callback),guardedInboundSend(other,{...scope,eventId:'ef'.repeat(32)},callback)]);
 expect(sends).toBe(1);expect(results.map(r=>r.status)).toEqual(['published','blocked']);
});
it('prevents content, recipient or text retargeting and rejects wrong receipts',()=>{
 const {journal}=provision();journal.begin(scope);
 for(const key of ['contentHash','recipientHash','textHash'])expect(()=>journal.begin({...scope,[key]:'ff'.repeat(32)})).toThrow();
 expect(()=>journal.recordPublished(scope,{...receipt,textHash:'ff'.repeat(32)})).toThrow();expect(journal.inspect().blocked).toBe(true);
});
it('receipt persistence failure leaves the durable guard set',async()=>{
 const {dir,journal}=provision();const fail={begin:journal.begin.bind(journal),recordPublished(){throw Error('disk failure');}};
 expect((await guardedInboundSend(fail,scope,async()=>receipt)).status).toBe('uncertain');const other=new InboundSendJournal(dir,identity);journals.push(other);expect(other.inspect().blocked).toBe(true);
});
it('process termination after arming remains blocked with no SDK restart',()=>{
 const {dir,journal}=provision();journal.close();
 const script=`import {InboundSendJournal} from ${JSON.stringify(new URL('../inbound-send-journal.js',import.meta.url).href)};const j=new InboundSendJournal(${JSON.stringify(dir)},${JSON.stringify(identity)});j.begin(${JSON.stringify(scope)});process.exit(42);`;
 expect(spawnSync(process.execPath,['--input-type=module','-e',script]).status).toBe(42);
 const other=new InboundSendJournal(dir,identity);journals.push(other);expect(other.inspect()).toEqual({blocked:true,eventId:scope.eventId});
});
it('rejects identity changes, unsafe file permissions and inconsistent guard state',()=>{
 const {dir,journal}=provision();expect(()=>new InboundSendJournal(dir,'ff'.repeat(32))).toThrow();journal.close();
 const path=join(dir,'send-journal.sqlite');chmodSync(path,0o644);expect(()=>new InboundSendJournal(dir,identity)).toThrow();chmodSync(path,0o600);
 const db=new DatabaseSync(path);db.prepare('UPDATE bridge SET active_event=?').run(scope.eventId);db.close();expect(()=>new InboundSendJournal(dir,identity)).toThrow();
});

it('recovers a committed publication receipt after its acknowledgement is lost without resending',async()=>{
 const {dir,journal}=provision();let sends=0;const lost={begin:journal.begin.bind(journal),recordPublished(s,r){journal.recordPublished(s,r);throw Error('ack lost');}};
 expect((await guardedInboundSend(lost,scope,async()=>{sends++;return receipt;})).status).toBe('uncertain');
 const reopened=new InboundSendJournal(dir,identity);journals.push(reopened);expect((await guardedInboundSend(reopened,scope,async()=>{sends++;return receipt;})).status).toBe('published');expect(sends).toBe(1);
});
