import {afterEach,describe,it,expect,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {chmodSync} from 'node:fs';
import {smtpFixture} from './helpers/smtp-fixture.js';
import {initializeSmtpJournal,openSmtpJournal} from '../../selfhost/mail-smtp-journal.mjs';
import {readSmtpSettings,createSmtpAdapter} from '../../selfhost/mail-smtp-transport.mjs';
const cleanup:any[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
 const wire=await smtpFixture();cleanup.push(()=>wire.close());
 const filename=join(wire.directory,'journal.sqlite'),key='ab'.repeat(32),{journalId}=initializeSmtpJournal({filename,key});
 const env={CHAT_SMTP_HOST:'127.0.0.1',CHAT_SMTP_PORT:String(wire.port),CHAT_SMTP_TLS_SERVERNAME:'smtp.test',CHAT_SMTP_TLS_CA_FILE:wire.cert,CHAT_SMTP_JOURNAL_FILE:filename,CHAT_SMTP_JOURNAL_KEY:key,CHAT_SMTP_JOURNAL_ID:journalId,CHAT_SMTP_USER:'synthetic-user',CHAT_SMTP_PASSWORD:'synthetic-password'};
 const config:any={provider:'smtp',service:'https://chat.example/api/mail',from:'chat@example.invalid',key:Buffer.from('cd'.repeat(32),'hex')};
 config.smtpProfile=(await readSmtpSettings(env,config)).profile;
 const adapter=await createSmtpAdapter(env,config);cleanup.push(()=>adapter.close());
 const command={requestId:`chirpy-mail/${'ab'.repeat(32)}/0x${'3'.repeat(40)}/${'cd'.repeat(16)}`,deadline:Date.now()+82800000,payload:{from:config.from,to:['recipient@example.invalid'],subject:'Synthetic SMTP subject',text:'Private synthetic body\n.dot line',headers:{'X-Chat-Bridge':'wallet-to-email'}}};
 return {wire,env,config,adapter,command};
}
describe('private TLS SMTP adapter',()=>{
 it.each(['--once','--status'])('starts safely disabled with %s without configuration or journal provisioning',mode=>{
  const result=spawnSync(process.execPath,['selfhost/mail-outbound-worker.mjs',mode],{env:{PATH:process.env.PATH,CHAT_MAIL_OUTBOUND_WORKER_ENABLED:'0'},encoding:'utf8',timeout:10000});
  expect(result.status).toBe(mode==='--once'?0:2);expect(JSON.parse(result.stdout)).toEqual({enabled:false,status:'disabled'});
 });

 it('authenticates TLS, rechecks permission before the envelope, preserves MIME scope and recovers without reconnecting',async()=>{
  const f=await fixture();const authorize=vi.fn(async()=>{expect(f.wire.state.auth).toBe(1);expect(f.wire.state.envelopes).toBe(0);return true;});
  const result=await f.adapter.submit(f.command,authorize);expect(result).toMatchObject({status:'accepted',attempts:1});
  expect(f.wire.state).toMatchObject({envelopes:1,plaintextAuth:0});expect(f.wire.state.rcpt).toEqual(['RCPT TO:<recipient@example.invalid>']);
  const message=f.wire.state.messages[0];expect(message).toContain('Message-ID: <'+result.id+'@example.invalid>');expect(message).toContain('X-Chat-Bridge: wallet-to-email');expect(message).toContain('Subject: Synthetic SMTP subject');expect(message).toContain('Private synthetic body');
  const reference=f.adapter.reference(f.command);expect(JSON.stringify(reference)).not.toContain(f.command.payload.to[0]);
  expect(f.adapter.recover(reference)).toEqual(result);expect(await f.adapter.submit(f.command,authorize)).toEqual(result);
  expect(authorize).toHaveBeenCalledOnce();expect(f.wire.state.connections).toBe(1);
 });
 it('holds a timed-out DATA acknowledgement as uncertain without retrying',{timeout:15000},async()=>{
  const f=await fixture();f.wire.state.mode='hang-ack';
  expect((await f.adapter.submit(f.command,async()=>true)).status).toBe('uncertain');
  expect((await f.adapter.submit(f.command,async()=>true)).status).toBe('uncertain');expect(f.wire.state.messages).toHaveLength(1);
 });
 it.each(['rcpt450','data450','rcpt550','data550','drop-ack'])('classifies actual %s wire outcome without unsafe retries',async mode=>{
  const f=await fixture();f.wire.state.mode=mode;
  const expected=mode.endsWith('450')?'retryable':mode.endsWith('550')?'rejected':'uncertain';
  const result=await f.adapter.submit(f.command,async()=>true);expect(result.status).toBe(expected);
  const before=f.wire.state.envelopes;f.wire.state.mode='accept';
  const second=await f.adapter.submit(f.command,async()=>true);
  expect(second.status).toBe(expected==='retryable'?'accepted':expected);
  expect(f.wire.state.envelopes).toBe(before+(expected==='retryable'?1:0));
 });
 it.each(['no-tls','wrong-name','wrong-ca','auth-denied'])('sends no envelope on %s and never sends credentials before TLS',async mode=>{
  const f=await fixture();let env={...f.env};
  if(mode==='wrong-name')env.CHAT_SMTP_TLS_SERVERNAME='wrong.test';
  else if(mode==='wrong-ca'){const other=await smtpFixture();cleanup.push(()=>other.close());env.CHAT_SMTP_TLS_CA_FILE=other.cert;}
  else f.wire.state.mode=mode;
  const config={...f.config,smtpProfile:(await readSmtpSettings(env,f.config)).profile};const adapter=await createSmtpAdapter(env,config);cleanup.push(()=>adapter.close());
  const authorize=vi.fn(async()=>true);expect(await adapter.submit(f.command,authorize)).toEqual({status:'retryable'});
  expect(authorize).not.toHaveBeenCalled();expect(f.wire.state).toMatchObject({envelopes:0,plaintextAuth:0});
  expect(adapter.recover(adapter.reference(f.command))).toEqual({status:'unknown'});
 });
 it('does not enter SMTP MAIL/DATA or journal a send when fresh permission is denied',async()=>{
  const f=await fixture();expect(await f.adapter.submit(f.command,async()=>false)).toEqual({status:'denied'});
  expect(f.wire.state.envelopes).toBe(0);expect(f.adapter.recover(f.adapter.reference(f.command))).toEqual({status:'unknown'});
 });
 it('refuses changed transport credentials, sender, trust identity and journal identity before connecting',async()=>{
  const f=await fixture();for(const patch of [{CHAT_SMTP_PASSWORD:'changed'},{CHAT_SMTP_TLS_SERVERNAME:'other.test'},{CHAT_SMTP_JOURNAL_KEY:'ef'.repeat(32)},{CHAT_SMTP_PORT:'26'}])await expect(createSmtpAdapter({...f.env,...patch},f.config)).rejects.toThrow();
  await expect(createSmtpAdapter(f.env,{...f.config,from:'other@example.invalid'})).rejects.toThrow();
  expect(f.wire.state.connections).toBe(0);
 });
 it('rejects non-loopback relay selection, unsafe trust permissions and malformed configuration',async()=>{
  const f=await fixture();for(const patch of [{CHAT_SMTP_HOST:'smtp.example.com'},{CHAT_SMTP_PORT:'0'},{CHAT_SMTP_USER:''},{CHAT_SMTP_TLS_SERVERNAME:'127.0.0.1'},{CHAT_SMTP_TLS_CA_FILE:'relative.pem'}])await expect(readSmtpSettings({...f.env,...patch},f.config)).rejects.toThrow();
  chmodSync(f.wire.cert,0o666);await expect(readSmtpSettings(f.env,f.config)).rejects.toThrow();
 });
 it('recovers a content-free reference only for its original immutable request scope',async()=>{
  const f=await fixture();await f.adapter.submit(f.command,async()=>true);
  const reference=f.adapter.reference(f.command);
  expect(()=>f.adapter.recover({...reference,deadline:reference.deadline-1})).toThrow();
  expect(()=>f.adapter.recover({...reference,digest:'00'.repeat(32)})).toThrow();
  const journal=openSmtpJournal({filename:f.env.CHAT_SMTP_JOURNAL_FILE,key:f.env.CHAT_SMTP_JOURNAL_KEY,journalId:f.env.CHAT_SMTP_JOURNAL_ID});
  try{expect(journal.recover(reference)).toMatchObject({status:'accepted'});}finally{journal.close();}
 });
});
