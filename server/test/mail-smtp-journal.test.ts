import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,chmodSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {initializeSmtpJournal,openSmtpJournal} from '../../selfhost/mail-smtp-journal.mjs';
const fixtures:any[]=[];
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'chat-smtp-journal-')),filename=join(directory,'journal.sqlite');
 const key='11'.repeat(32),{journalId}=initializeSmtpJournal({filename,key});
 const time={value:Date.now()},config={filename,key,journalId,now:()=>time.value};
 const journal=openSmtpJournal(config);
 const command={requestId:`chirpy-mail/${'ab'.repeat(32)}/0x${'3'.repeat(40)}/${'cd'.repeat(16)}`,deadline:time.value+82800000,
  payload:{from:'chat@example.invalid',to:['recipient@example.invalid'],subject:'Synthetic private subject',text:'Synthetic confidential body',headers:{'X-Chat-Bridge':'wallet-to-email'}}};
 const f={directory,filename,config,journal,command,time};fixtures.push(f);return f;
}
afterEach(()=>{for(const f of fixtures.splice(0)){f.journal.close();rmSync(f.directory,{recursive:true,force:true});}});
const callbacks=()=>({authorize:vi.fn(async()=>true),send:vi.fn(async(_payload:Record<string,unknown>):Promise<Record<string,unknown>>=>({status:'accepted'}))});

describe('durable SMTP submission boundary',()=>{
 it('commits uncertain state before send, stores no message/recipient/request text and recovers acceptance',async()=>{
  const f=fixture(),c=callbacks();
  c.send.mockImplementation(async payload=>{
   const other=openSmtpJournal(f.config);
   try{expect(other.inspect(f.command)).toMatchObject({status:'uncertain',attempts:1});}finally{other.close();}
   expect(payload.messageId).toMatch(/^<smtp_[a-f0-9]{32}@example.invalid>$/);
   expect(payload).toMatchObject(f.command.payload);return {status:'accepted'};
  });
  const result=await f.journal.submit(f.command,c);expect(result).toMatchObject({status:'accepted',attempts:1});
  f.journal.close();f.journal=openSmtpJournal(f.config);
  const disabled={authorize:vi.fn(async()=>false),send:vi.fn()};
  expect(await f.journal.submit(f.command,disabled)).toEqual(result);expect(disabled.authorize).not.toHaveBeenCalled();expect(disabled.send).not.toHaveBeenCalled();
  const db=new DatabaseSync(f.filename,{readOnly:true});
  const stored=JSON.stringify(db.prepare('SELECT * FROM submissions').all());db.close();
  for(const value of [f.command.requestId,...f.command.payload.to,f.command.payload.from,f.command.payload.subject,f.command.payload.text])expect(stored).not.toContain(value);
 });
 it.each(['throw','malformed','ambiguous-retry'])('never repeats an uncertain %s outcome after reopen',async(mode)=>{
  const f=fixture(),c=callbacks();c.send.mockImplementation(async()=>{if(mode==='throw')throw Error('SMTP acknowledgement lost');return mode==='malformed'?{}:{status:'retryable'};});
  expect(await f.journal.submit(f.command,c)).toMatchObject({status:'uncertain'});
  f.journal.close();f.journal=openSmtpJournal(f.config);
  expect(await f.journal.submit(f.command,c)).toMatchObject({status:'uncertain'});expect(c.send).toHaveBeenCalledTimes(1);
 });
 it('allows only one accepting call across independent handles and overlapping authorization',async()=>{
  const f=fixture(),other=openSmtpJournal(f.config);let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve});const send=vi.fn(async()=>{await blocked;return {status:'accepted'}});
  try{
   const first=f.journal.submit(f.command,{authorize:async()=>true,send});
   await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1));
   expect(await other.submit(f.command,{authorize:async()=>true,send})).toMatchObject({status:'uncertain'});
   release();expect(await first).toMatchObject({status:'accepted'});expect(send).toHaveBeenCalledTimes(1);
  }finally{release();other.close();}
 });
 it('recovers an overlapping submission instead of reporting a later denial as never sent',async()=>{
  const f=fixture(),other=openSmtpJournal(f.config);let release!:(allowed:boolean)=>void;
  const authorization=new Promise<boolean>(resolve=>{release=resolve});const send=vi.fn();
  try{
   const delayed=f.journal.submit(f.command,{authorize:()=>authorization,send});
   const accepted=await other.submit(f.command,callbacks());
   release(false);expect(await delayed).toEqual(accepted);expect(send).not.toHaveBeenCalled();
  }finally{release(false);other.close();}
 });
 it('permits bounded retries only on explicit definitive nonacceptance, with fresh permission',async()=>{
  const f=fixture(),c=callbacks();c.send.mockResolvedValue({status:'retryable',definitiveNoAcceptance:true});
  const ids=new Set();for(let i=1;i<=5;i++){const r=await f.journal.submit(f.command,c);expect(r).toMatchObject({status:i===5?'rejected':'retryable',attempts:i});ids.add(r.id);}
  expect(ids.size).toBe(1);expect(c.authorize).toHaveBeenCalledTimes(5);expect(c.send).toHaveBeenCalledTimes(5);
  expect(await f.journal.submit(f.command,c)).toMatchObject({status:'rejected',attempts:5});expect(c.send).toHaveBeenCalledTimes(5);
 });
 it('denial, expiration and cancellation before reservation never invoke SMTP or create a ledger entry',async()=>{
  const f=fixture(),c=callbacks();c.authorize.mockResolvedValue(false);
  expect(await f.journal.submit(f.command,c)).toEqual({status:'denied'});
  c.authorize.mockImplementation(async()=>{f.time.value=f.command.deadline;return true});
  expect(await f.journal.submit(f.command,c)).toEqual({status:'expired'});
  f.time.value=f.command.deadline-100;const signal=AbortSignal.abort();
  await expect(f.journal.submit(f.command,{...c,signal})).rejects.toThrow();
  expect(f.journal.inspect(f.command)).toEqual({status:'unknown'});expect(c.send).not.toHaveBeenCalled();
 });
 it('rechecks permission and deadline before retrying a definite nonacceptance',async()=>{
  const f=fixture(),c=callbacks();c.send.mockResolvedValue({status:'retryable',definitiveNoAcceptance:true});
  expect(await f.journal.submit(f.command,c)).toMatchObject({status:'retryable',attempts:1});
  c.authorize.mockResolvedValue(false);
  expect(await f.journal.submit(f.command,c)).toEqual({status:'denied'});
  c.authorize.mockResolvedValue(true);f.time.value=f.command.deadline;
  expect(await f.journal.submit(f.command,c)).toEqual({status:'expired'});
  expect(c.send).toHaveBeenCalledTimes(1);
 });
 it('keeps a definitive rejection terminal across reopen',async()=>{
  const f=fixture(),c=callbacks();c.send.mockResolvedValue({status:'rejected',definitiveNoAcceptance:true});
  const result=await f.journal.submit(f.command,c);expect(result).toMatchObject({status:'rejected',attempts:1});
  f.journal.close();f.journal=openSmtpJournal(f.config);
  expect(await f.journal.submit(f.command,c)).toEqual(result);expect(c.send).toHaveBeenCalledTimes(1);
 });
 it('snapshots the immutable scope before asynchronous authorization',async()=>{
  const f=fixture(),original=structuredClone(f.command),c=callbacks();
  c.authorize.mockImplementation(async()=>{f.command.payload.to[0]='changed@example.invalid';f.command.payload.text='changed';return true});
  await f.journal.submit(f.command,c);expect(c.send.mock.calls[0][0]).toMatchObject(original.payload);
  expect(f.journal.inspect(original)).toMatchObject({status:'accepted'});expect(()=>f.journal.inspect(f.command)).toThrow(/conflicts/);
 });
 it.each(['recipient','subject','text','from','deadline'])('rejects %s changes for an existing request, before any new send',async(field)=>{
  const f=fixture(),c=callbacks();await f.journal.submit(f.command,c);const changed=structuredClone(f.command);
  if(field==='recipient')changed.payload.to=['changed@example.invalid'];else if(field==='deadline')changed.deadline--;else if(field==='from')changed.payload.from='other@example.invalid';else if(field==='subject'||field==='text')changed.payload[field]+=' changed';
  await expect(f.journal.submit(changed,c)).rejects.toThrow(/conflicts/);expect(c.send).toHaveBeenCalledTimes(1);
 });
 it.each(['multiple-recipients','extra-header','header-injection','large-body','extra-field','bad-id','far-deadline'])('rejects malformed scope %s without calling SMTP',async(kind)=>{
  const f=fixture(),c=callbacks();const command:any=structuredClone(f.command);
  if(kind==='multiple-recipients')command.payload.to.push('second@example.invalid');
  if(kind==='extra-header')command.payload.headers.Bcc='second@example.invalid';
  if(kind==='header-injection')command.payload.subject+='\r\nBcc: injected@example.invalid';
  if(kind==='large-body')command.payload.text='x'.repeat(24577);
  if(kind==='extra-field')command.payload.attachments=[];
  if(kind==='bad-id')command.requestId='invalid';
  if(kind==='far-deadline')command.deadline++;
  await expect(f.journal.submit(command,c)).rejects.toThrow();expect(c.authorize).not.toHaveBeenCalled();expect(c.send).not.toHaveBeenCalled();
 });
 it('does not create missing state, replace an existing ledger or accept the wrong key/instance',()=>{
  const f=fixture();expect(()=>initializeSmtpJournal(f.config)).toThrow();
  expect(()=>openSmtpJournal({...f.config,key:'22'.repeat(32)})).toThrow();
  expect(()=>openSmtpJournal({...f.config,journalId:'00000000-0000-0000-0000-000000000000'})).toThrow();
  expect(()=>openSmtpJournal({...f.config,filename:join(f.directory,'missing.sqlite')})).toThrow();
  chmodSync(f.filename,0o644);expect(()=>openSmtpJournal(f.config)).toThrow();chmodSync(f.filename,0o600);
 });
 it('detects a replaced journal while a worker has an open handle',async()=>{
  const f=fixture();renameSync(f.filename,f.filename+'.old');initializeSmtpJournal({filename:f.filename,key:f.config.key});
  const c=callbacks();await expect(f.journal.submit(f.command,c)).rejects.toThrow();expect(c.send).not.toHaveBeenCalled();
 });
 it('survives an actual process kill after the durable boundary without attempting a resend',{timeout:15000},async()=>{
  const f=fixture();f.journal.close();
  const source=`import {openSmtpJournal} from ${JSON.stringify(pathToFileURL(resolve('selfhost/mail-smtp-journal.mjs')).href)};const c=JSON.parse(process.env.JOURNAL_FIXTURE);const j=openSmtpJournal(c.config);await j.submit(c.command,{authorize:async()=>true,send:async()=>{setInterval(()=>{},1000);process.stdout.write('entered-send\\n');await new Promise(()=>{});}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,JOURNAL_FIXTURE:JSON.stringify({config:f.config,command:f.command})},stdio:['ignore','pipe','pipe']});
  try{
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Child did not reach durable send boundary')),8000);child.stdout.on('data',data=>{if(data.toString().includes('entered-send')){clearTimeout(timer);resolve();}});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('Child exited before send boundary'));});});
   const exited=once(child,'exit');child.kill('SIGKILL');await exited;
   f.journal=openSmtpJournal(f.config);const c=callbacks();expect(await f.journal.submit(f.command,c)).toMatchObject({status:'uncertain'});expect(c.send).not.toHaveBeenCalled();
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
 });
 it('keeps private unresolved counts and bounded receipt-only inspection across restart',async()=>{
  const f=fixture(),c=callbacks();c.send.mockResolvedValue({status:'uncertain'});
  expect(f.journal.summary()).toEqual({uncertainCount:0,staleUncertainCount:0,oldestUncertainAt:null});
  const receipts=[];for(let i=0;i<3;i++){const command={...f.command,requestId:f.command.requestId.slice(0,-32)+i.toString(16).padStart(32,'0')};receipts.push((await f.journal.submit(command,c)).id);}
  expect(f.journal.summary()).toMatchObject({uncertainCount:3,staleUncertainCount:0});
  f.time.value+=60001;expect(f.journal.summary()).toMatchObject({uncertainCount:3,staleUncertainCount:3});
  f.journal.close();f.journal=openSmtpJournal(f.config);
  const page=f.journal.pending({limit:2});expect(page.items).toHaveLength(2);expect(page.nextCursor).toBe(page.items[1].id);
  const last=f.journal.pending({after:page.nextCursor,limit:2});expect(last.items).toHaveLength(1);expect(last.nextCursor).toBeNull();
  expect([...page.items,...last.items].map(r=>r.id).sort()).toEqual(receipts.sort());
  const output=JSON.stringify({summary:f.journal.summary(),page,last});for(const privateValue of [f.command.requestId,f.command.payload.to[0],f.command.payload.text,f.command.payload.subject,f.command.payload.from,f.config.key])expect(output).not.toContain(privateValue);
  expect(Object.keys(page.items[0]).sort()).toEqual(['attempts','createdAt','id','status','updatedAt']);
  for(const options of [{limit:0},{limit:51},{after:'bad'},{limit:1.5}])expect(()=>f.journal.pending(options)).toThrow();
 });
 it('shows an in-flight reservation but clears it only after the journal observes acceptance',async()=>{
  const f=fixture(),c=callbacks();
  c.send.mockImplementation(async()=>{expect(f.journal.summary()).toMatchObject({uncertainCount:1,staleUncertainCount:0});return {status:'accepted'};});
  await f.journal.submit(f.command,c);expect(f.journal.summary().uncertainCount).toBe(0);expect(f.journal.pending()).toEqual({items:[],nextCursor:null});
 });

});
