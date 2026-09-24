import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {join} from 'node:path';
import {renameSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {smtpFixture} from './helpers/smtp-fixture.js';
import {initializeSmtpJournal} from '../../selfhost/mail-smtp-journal.mjs';
import {readSmtpSettings,createSmtpAdapter} from '../../selfhost/mail-smtp-transport.mjs';
import {mailConfig,createMailService,bindingKey,suppressionKey,hash} from '../mail-service.js';
import {FINISH_MAIL,AUTHORIZE_SMTP,PIN_SMTP_REFERENCE} from '../mail-store.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER,exec=promisify(execFile),wallet=`0x${'3'.repeat(40)}`;
describe.skipIf(!container)('SMTP queue, journal and TLS wire recovery',{timeout:30000},()=>{
 let wire:any,env:any,config:any,adapter:any,c:any,binding:any,key:string,queue:string,bk:string;
 const keys=new Set<string>();
 const redis=async(args:any[])=>{
  if(args[0]==='SET')keys.add(args[1]);if(args[0]==='EVAL')args.slice(3,3+Number(args[2])).forEach(k=>keys.add(k));
  const {stdout}=await exec('docker',['exec',container!,'redis-cli','--json',...args.map(String)],{maxBuffer:2000000});const value=JSON.parse(stdout);if(typeof value==='string'&&value.startsWith('ERR '))throw Error(value);return value;
 };
 const request=vi.fn(async(_url:any,options:any)=>{const scope=JSON.parse(options.body);return Response.json({...scope,version:scope.expectedVersion,email:c.to,expiresAt:Date.now()+60000});});
 const service=(kv:any=redis,transport:any=adapter)=>createMailService(config,kv,request,transport);
 const stored=async()=>JSON.parse(await redis(['GET',key]));
 const ready=async()=>{const j=await stored();j.lockedUntil=0;await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);await redis(['ZADD',queue,'0',key]);};
 beforeEach(async()=>{
  wire=await smtpFixture();const filename=join(wire.directory,'journal.sqlite'),journalKey='ab'.repeat(32),{journalId}=initializeSmtpJournal({filename,key:journalKey});
  env={CHIRPY_MAIL_ENABLED:'1',CHIRPY_MAIL_PROVIDER:'smtp',CHAT_SMTP_PROFILE:'0'.repeat(64),CHIRPY_MAIL_SERVICE_URL:'https://chat.test/api/mail',KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'synthetic',CHIRPY_MAIL_FROM:'chat@example.invalid',CHIRPY_MAIL_SENDERS:wallet,CHIRPY_MAIL_DATA_KEY:'cd'.repeat(32),CHIRPY_MAIL_WORKER_SECRET:'test'.repeat(10),CHIRPY_MAIL_IDENTITY_URL:'https://wallet.test/api/service/delivery',CHIRPY_MAIL_IDENTITY_SECRET:'synthetic'.repeat(8),CHAT_SMTP_HOST:'127.0.0.1',CHAT_SMTP_PORT:String(wire.port),CHAT_SMTP_TLS_SERVERNAME:'smtp.test',CHAT_SMTP_TLS_CA_FILE:wire.cert,CHAT_SMTP_JOURNAL_FILE:filename,CHAT_SMTP_JOURNAL_KEY:journalKey,CHAT_SMTP_JOURNAL_ID:journalId};
  config=mailConfig(env);config.smtpProfile=(await readSmtpSettings(env,config)).profile;config.prefix+=randomBytes(8).toString('hex')+':';
  adapter=await createSmtpAdapter(env,config);
  c={action:'send',wallet,service:config.service,id:randomBytes(16).toString('hex'),expiresAt:Date.now()+60000,to:'recipient@example.invalid',subject:'Synthetic queue message',text:'Synthetic private body'};
  binding={wallet,email:c.to,version:randomBytes(16).toString('hex'),revoked:false,verifiedAt:Date.now()-2000,consentedAt:Date.now()-1000,expiresAt:Date.now()+3600000,evidenceId:'synthetic',identity:{bindingId:'synthetic-wallet-binding',version:1}};
  bk=bindingKey(config,wallet,c.to);key=`${config.prefix}job:${hash(`${wallet}\n${c.id}`)}`;queue=`${config.prefix}queue`;
  await redis(['SET',bk,JSON.stringify(binding)]);request.mockClear();
 });
 afterEach(async()=>{vi.restoreAllMocks();adapter?.close();await wire?.close();if(keys.size)await redis(['DEL',...keys]);keys.clear();});
 it('enqueues on the public service but rejects a remote drain before any queue access',async()=>{
  expect((await createMailService(config,redis,request).execute(c)).status).toBe('queued');
  const kv=vi.fn();await expect(createMailService(config,kv,request).drain()).rejects.toThrow('Private SMTP');expect(kv).not.toHaveBeenCalled();expect((await stored()).attempts).toBe(0);
  expect(await service().drain()).toEqual({processed:1,uncertain:0});expect((await stored()).status).toBe('accepted');expect(wire.state.messages).toHaveLength(1);expect(request).toHaveBeenCalledTimes(2);
  expect(await redis(['GET',key+':payload'])).toBeNull();const status=await service().execute({...c,action:'status'});expect(JSON.stringify(status)).not.toContain('smtp_');
 });
 it.each(['accept','drop-ack'])('recovers %s after a lost Redis completion, expiry, revoked consent and erased content without reconnecting',async mode=>{
  wire.state.mode=mode;const crashing=service(async args=>{if(args[0]==='EVAL'&&args[1]===FINISH_MAIL)throw Error('completion lost');return redis(args);});
  await crashing.execute(c);
  const job=await stored();job.deadline=Date.now()+2000;await redis(['SET',key,JSON.stringify(job),'KEEPTTL']);
  await expect(crashing.drain()).rejects.toThrow('completion lost');expect((await stored()).status).toBe('sending');expect(wire.state.messages).toHaveLength(1);
  adapter.close();adapter=await createSmtpAdapter(env,config);
  await redis(['DEL',key+':payload']);await redis(['SET',bk,JSON.stringify({...binding,revoked:true})]);config.senders=[];config.identity=null;
  await new Promise(resolve=>setTimeout(resolve,2100));await ready();const old=await stored();old.attempts=5;await redis(['SET',key,JSON.stringify(old),'KEEPTTL']);
  expect((await service().drain()).processed).toBe(1);expect((await stored()).status).toBe(mode==='accept'?'accepted':'uncertain');expect((await stored()).attempts).toBe(5);expect(wire.state.connections).toBe(1);expect(wire.state.messages).toHaveLength(1);expect(await redis(['ZCARD',queue])).toBe(0);
 });
 it('retains the sending claim on missing journal, rather than reporting stopped or resending',async()=>{
  const crashing=service(async args=>{if(args[0]==='EVAL'&&args[1]===FINISH_MAIL)throw Error('completion lost');return redis(args);});await crashing.execute(c);await expect(crashing.drain()).rejects.toThrow();await ready();
  renameSync(env.CHAT_SMTP_JOURNAL_FILE,env.CHAT_SMTP_JOURNAL_FILE+'.old');const before=await redis(['GET',key]);await expect(service().drain()).rejects.toThrow();expect(await redis(['GET',key])).toBe(before);expect(wire.state.messages).toHaveLength(1);
 });
 it('does not claim a queue pinned to another SMTP profile or a Resend provider',async()=>{
  await service().execute(c);const before=await redis(['GET',key]);
  const foreign={...config,smtpProfile:'ef'.repeat(32)};const fake={...adapter,profile:foreign.smtpProfile};
  await expect(createMailService(foreign,redis,request,fake).drain()).rejects.toThrow('provider');
  const resend={...config,provider:'resend',providerKey:'synthetic'};await expect(createMailService(resend,redis,request).drain()).rejects.toThrow('provider');
  expect(await redis(['GET',key])).toBe(before);expect(wire.state.connections).toBe(0);
 });
 it.each(['suppressed','revoked','wallet-denied','wallet-unavailable','identity-removed','lease-replaced'])('checks fresh %s authority immediately before the send boundary',async kind=>{
  await service().execute(c);
  if(kind==='identity-removed')config.identity=null;
  request.mockImplementationOnce(async(_url,options)=>{
   if(kind==='suppressed')await redis(['SET',suppressionKey(config,c.to),'1']);
   if(kind==='revoked')await redis(['SET',bk,JSON.stringify({...binding,revoked:true})]);
   if(kind==='lease-replaced'){const j=await stored();j.lease='different';await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);}
   if(kind==='wallet-denied')return new Response('',{status:403});if(kind==='wallet-unavailable')return new Response('',{status:503});
   const scope=JSON.parse(options.body);return Response.json({...scope,version:scope.expectedVersion,email:c.to,expiresAt:Date.now()+60000});
  });
  if(['wallet-unavailable','lease-replaced'].includes(kind))await expect(service().drain()).rejects.toThrow();else await service().drain();
  expect(wire.state.envelopes).toBe(0);expect((await stored()).status).toBe(['wallet-unavailable','lease-replaced'].includes(kind)?'sending':'stopped');
 });
 it('bounds definitive SMTP retries and performs fresh authorization on each attempt',async()=>{
  wire.state.mode='data450';await service().execute(c);const ids=new Set();
  for(let i=1;i<=5;i++){await service().drain();const j=await stored();expect(j.attempts).toBe(i);expect(j.status).toBe(i===5?'stopped':'queued');ids.add(j.providerId);if(i<5)await ready();}
  expect(wire.state.messages).toHaveLength(5);expect(ids.size).toBe(1);expect(request).toHaveBeenCalledTimes(6);expect(await redis(['GET',key+':payload'])).toBeNull();
 });
 it('holds uncertainty without automatically resending when the server disconnects after DATA',async()=>{
  wire.state.mode='drop-ack';await service().execute(c);expect(await service().drain()).toEqual({processed:1,uncertain:1});
  expect((await stored()).status).toBe('uncertain');expect(await service().execute(c)).toEqual({status:'uncertain',id:c.id});await service().drain();expect(wire.state.messages).toHaveLength(1);
 });
 it('fails before SMTP on a lost reference write or content-free scope conflict',async()=>{
  await service().execute(c);const failing=service(async args=>{if(args[0]==='EVAL'&&args[1]===PIN_SMTP_REFERENCE)throw Error('reference unavailable');return redis(args);});
  await expect(failing.drain()).rejects.toThrow('reference unavailable');expect(wire.state.connections).toBe(0);await ready();
  const j=await stored();j.smtpReference={requestId:'wrong',deadline:j.deadline,digest:'00'.repeat(32)};await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);
  await expect(service().drain()).rejects.toThrow('scope');expect(wire.state.connections).toBe(0);
 });
 it('recovers an interrupted preflight with no journal submission only after fresh consent',async()=>{
  await service().execute(c);const crashing=service(redis,{...adapter,submit:async()=>{throw Error('killed before SMTP');}});
  await expect(crashing.drain()).rejects.toThrow();expect((await stored()).smtpReference).toBeDefined();await ready();
  await service().drain();expect((await stored()).status).toBe('accepted');expect(wire.state.messages).toHaveLength(1);
 });
 it('stops an unsubmitted request with expired content without inventing an uncertain send',async()=>{
  await service().execute(c);await redis(['DEL',key+':payload']);await service().drain();expect((await stored()).status).toBe('stopped');expect(wire.state.connections).toBe(0);
 });
});
