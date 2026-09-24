import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {join} from 'node:path';
import {renameSync,writeFileSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {smtpFixture} from './helpers/smtp-fixture.js';
import {initializeSmtpJournal} from '../../selfhost/mail-smtp-journal.mjs';
import {readSmtpSettings,createSmtpAdapter} from '../../selfhost/mail-smtp-transport.mjs';
import {mailConfig,createMailService,bindingKey,suppressionKey,hash} from '../mail-service.js';
import {CLAIM_MAIL,FINISH_MAIL,AUTHORIZE_SMTP,PIN_SMTP_REFERENCE,RECONCILE_SMTP_RECEIPT} from '../mail-store.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER,exec=promisify(execFile),wallet=`0x${'3'.repeat(40)}`;
describe.skipIf(!container)('SMTP queue, journal and TLS wire recovery',{timeout:30000},()=>{
 let wire:any,env:any,config:any,adapter:any,c:any,binding:any,key:string,queue:string,bk:string;
 const keys=new Set<string>();
 const redis=async(args:any[])=>{
  if(args[0]==='SET')keys.add(args[1]);if(args[0]==='EVAL')args.slice(3,3+Number(args[2])).forEach(k=>keys.add(k));
  const {stdout}=await exec('docker',['exec',container!,'redis-cli','--json',...args.map(String)],{maxBuffer:2000000});const value=JSON.parse(stdout);if(typeof value==='string'&&value.startsWith('ERR '))throw Error(value);return value;
 };
 const authority=async(_url:any,options:any)=>{const scope=JSON.parse(options.body);return Response.json({...scope,version:scope.expectedVersion,email:c.to,expiresAt:Date.now()+60000});};
 const request=vi.fn(authority);
 const service=(kv:any=redis,transport:any=adapter)=>createMailService(config,kv,request,transport);
 const stored=async()=>JSON.parse(await redis(['GET',key]));
 const ready=async()=>{const j=await stored();j.lockedUntil=0;await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);await redis(['ZADD',queue,'0',key]);};
 beforeEach(async()=>{
  wire=await smtpFixture();const filename=join(wire.directory,'journal.sqlite'),journalKey='ab'.repeat(32),{journalId}=initializeSmtpJournal({filename,key:journalKey});
  env={CHIRPY_MAIL_ENABLED:'1',CHIRPY_MAIL_PROVIDER:'smtp',CHAT_SMTP_PROFILE:'0'.repeat(64),CHIRPY_MAIL_SERVICE_URL:`https://chat-${randomBytes(8).toString('hex')}.test/api/mail`,KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'synthetic',CHIRPY_MAIL_FROM:'chat@example.invalid',CHIRPY_MAIL_SENDERS:wallet,CHIRPY_MAIL_DATA_KEY:'cd'.repeat(32),CHIRPY_MAIL_WORKER_SECRET:'test'.repeat(10),CHIRPY_MAIL_IDENTITY_URL:'https://wallet.test/api/service/delivery',CHIRPY_MAIL_IDENTITY_SECRET:'synthetic'.repeat(8),CHAT_SMTP_HOST:'127.0.0.1',CHAT_SMTP_PORT:String(wire.port),CHAT_SMTP_TLS_SERVERNAME:'smtp.test',CHAT_SMTP_TLS_CA_FILE:wire.cert,CHAT_SMTP_JOURNAL_FILE:filename,CHAT_SMTP_JOURNAL_KEY:journalKey,CHAT_SMTP_JOURNAL_ID:journalId};
  config=mailConfig(env);config.smtpProfile=(await readSmtpSettings(env,config)).profile;
  adapter=await createSmtpAdapter(env,config);
  c={action:'send',wallet,service:config.service,id:randomBytes(16).toString('hex'),expiresAt:Date.now()+60000,to:'recipient@example.invalid',subject:'Synthetic queue message',text:'Synthetic private body'};
  binding={wallet,email:c.to,version:randomBytes(16).toString('hex'),revoked:false,verifiedAt:Date.now()-2000,consentedAt:Date.now()-1000,expiresAt:Date.now()+3600000,evidenceId:'synthetic',identity:{bindingId:'synthetic-wallet-binding',version:1}};
  bk=bindingKey(config,wallet,c.to);key=`${config.prefix}job:${hash(`${wallet}\n${c.id}`)}`;queue=`${config.prefix}queue`;
  await redis(['SET',bk,JSON.stringify(binding)]);request.mockReset().mockImplementation(authority);
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
 async function lateOutcome(reply='250 2.0.0 Accepted synthetic'){
  wire.state.mode='hold-ack';await service().execute(c);
  const first=service().drain().then(()=>null,error=>error);
  await vi.waitFor(()=>expect(wire.state.messages).toHaveLength(1));
  expect((await service().workerStatus()).journalUncertainCount).toBe(1);
  await ready();expect(await service().drain()).toEqual({processed:1,uncertain:1});
  wire.state.ack(reply);expect(await first).toBeInstanceOf(Error);
  expect((await stored()).status).toBe('uncertain');
 }
 it('retains a degraded operator signal through idle ticks, restart and empty queue without exposing private scope',async()=>{
  wire.state.mode='drop-ack';await service().execute(c);await service().drain();
  for(let i=0;i<2;i++){
   await service().drain();const privateHealth=await service().workerStatus(),remoteHealth=await createMailService(config,redis,request).workerStatus();
   expect(privateHealth).toMatchObject({workerHealthy:false,queued:0,uncertainCount:1,journalUncertainCount:1});
   expect(remoteHealth).toMatchObject({workerHealthy:false,uncertainCount:1});
   for(const value of [wallet,c.to,c.subject,c.id,(await stored()).providerId])expect(JSON.stringify({privateHealth,remoteHealth})).not.toContain(value);
   adapter.close();adapter=await createSmtpAdapter(env,config);
  }
  expect(wire.state.messages).toHaveLength(1);expect(await service().reconcile({apply:true})).toMatchObject({reviewed:1,eligible:0,reconciled:0,unresolved:1});expect((await stored()).status).toBe('uncertain');
 });
 it.each([['250 2.0.0 Accepted synthetic','accepted','accepted'],['550 5.7.0 Rejected synthetic','stopped','rejected'],['450 4.3.0 Deferred synthetic','stopped','retryable']])('reconciles late %s evidence after content removal, without resending or renewing retention',async(reply,status,evidence)=>{
  await lateOutcome(reply);const before=await redis(['GET',key]),ttl=await redis(['PTTL',key]),calls=request.mock.calls.length;
  expect(await redis(['GET',key+':payload'])).toBeNull();expect((await service().workerStatus()).workerHealthy).toBe(false);
  config.senders=[];config.identity=null;await redis(['SET',bk,JSON.stringify({...binding,revoked:true})]);
  expect(await service().reconcile()).toMatchObject({reviewed:1,eligible:1,reconciled:0,applied:false});expect(await redis(['GET',key])).toBe(before);
  expect(await service().reconcile({apply:true})).toMatchObject({reviewed:1,eligible:1,reconciled:1,applied:true});
  const j=await stored();expect(j.status).toBe(status);expect(j.smtpReconciliation).toMatchObject({source:'smtp-journal',previousStatus:'uncertain',journalStatus:evidence,receiptId:j.providerId,attempts:1});
  expect(await redis(['PTTL',key])).toBeLessThanOrEqual(ttl);expect(await redis(['ZCARD',queue+':uncertain'])).toBe(0);expect(await redis(['ZCARD',queue])).toBe(0);expect(await redis(['GET',key+':payload'])).toBeNull();
  expect((await service().workerStatus()).workerHealthy).toBe(true);expect(await service().reconcile({apply:true})).toMatchObject({reviewed:0,reconciled:0});
  expect(request).toHaveBeenCalledTimes(calls);expect(wire.state.connections).toBe(1);expect(wire.state.messages).toHaveLength(1);
  const publicReceipt=await service().execute({...c,action:'status'});expect(publicReceipt.status).toBe(status);expect(JSON.stringify(publicReceipt)).not.toContain('smtpReconciliation');expect(JSON.stringify(publicReceipt)).not.toContain(j.providerId);
 });
 it('keeps an orphaned hold visible when the user receipt has expired',async()=>{
  wire.state.mode='drop-ack';await service().execute(c);await service().drain();await redis(['DEL',key]);
  expect(await service().reconcile({apply:true})).toMatchObject({reviewed:1,orphaned:1,reconciled:0});expect((await service().workerStatus()).uncertainCount).toBe(1);expect(await redis(['ZCARD',queue+':uncertain'])).toBe(1);expect(wire.state.messages).toHaveLength(1);
 });
 it('compares the exact receipt atomically before applying journal evidence',async()=>{
  await lateOutcome();const racing=service(async args=>{
   if(args[0]==='EVAL'&&args[1]===RECONCILE_SMTP_RECEIPT){const j=await stored();j.operatorMarker='concurrent';await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);}
   return redis(args);
  });
  expect(await racing.reconcile({apply:true})).toMatchObject({eligible:1,reconciled:0,conflicts:1});expect((await stored()).status).toBe('uncertain');expect(await redis(['ZCARD',queue+':uncertain'])).toBe(1);
  expect(await service().reconcile({apply:true})).toMatchObject({reconciled:1});expect((await stored()).operatorMarker).toBe('concurrent');
 });
 it.each(['provider','missing-reference','wrong-reference','wrong-receipt','wallet-shape','id-shape'])('preserves a hold with conflicting %s evidence',async kind=>{
  await lateOutcome();const j=await stored();
  if(kind==='wallet-shape')j.wallet=[j.wallet];
  if(kind==='id-shape')j.id=[j.id];
  if(kind==='provider')j.deliveryProvider='smtp-v1:'+'00'.repeat(32);
  if(kind==='missing-reference')delete j.smtpReference;
  if(kind==='wrong-reference')j.smtpReference.digest='00'.repeat(32);
  if(kind==='wrong-receipt')j.providerId='smtp_'+'00'.repeat(16);
  await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);const before=await redis(['GET',key]);
  if(['wallet-shape','id-shape'].includes(kind))await expect(service().indexHolds({apply:true})).rejects.toThrow();
  if(['provider','missing-reference'].includes(kind))expect(await service().reconcile({apply:true})).toMatchObject({conflicts:1,reconciled:0});else await expect(service().reconcile({apply:true})).rejects.toThrow();
  expect(await redis(['GET',key])).toBe(before);expect(await redis(['ZCARD',queue+':uncertain'])).toBe(1);expect(wire.state.messages).toHaveLength(1);
 });
 it('leaves unknown journal outcomes held instead of claiming definite failure',async()=>{
  wire.state.mode='drop-ack';await service().execute(c);await service().drain();const unknown={...adapter,recover:()=>({status:'unknown'})};
  expect(await service(redis,unknown).reconcile({apply:true})).toMatchObject({unresolved:1,reconciled:0});expect((await stored()).status).toBe('uncertain');
 });
 it('requires a private adapter for reconciliation before reading any queue state',async()=>{
  const kv=vi.fn();await expect(createMailService(config,kv,request).reconcile({apply:true})).rejects.toThrow('Private SMTP');expect(kv).not.toHaveBeenCalled();
 });
 it('paginates a bounded private hold index and rejects cross-service or malformed pointers',async()=>{
  const original={...c};wire.state.mode='drop-ack';
  for(let i=0;i<3;i++){c.id=randomBytes(16).toString('hex');await service().execute(c);await service().drain();}
  c=original;
  const first=await service().reconcile({limit:2});expect(first).toMatchObject({reviewed:2,unresolved:2});expect(first.nextCursor).toMatch(/^[a-f0-9]{64}$/);
  expect(await service().reconcile({limit:2,cursor:first.nextCursor})).toMatchObject({reviewed:1,unresolved:1,nextCursor:null});
  for(const options of [{limit:0},{limit:51},{cursor:'bad'},{apply:'yes'}])await expect(service().reconcile(options)).rejects.toThrow();
  await redis(['ZADD',queue+':uncertain','0','foreign-service:job:'+'ab'.repeat(32)]);await expect(service().reconcile()).rejects.toThrow();
 });

 it('keeps CLI health degraded on idle/restart and supports explicit paused inspection without identity or SMTP requests',async()=>{
  wire.state.mode='drop-ack';await service().execute(c);await service().drain();
  const preload=join(wire.directory,'test-kv.mjs'),calls=join(wire.directory,'test-kv-calls.jsonl');
  writeFileSync(preload,`import {execFileSync} from 'node:child_process';import {appendFileSync} from 'node:fs';globalThis.fetch=async(url,options)=>{if(url!=='https://kv.test/')throw Error('Unexpected network request');const args=JSON.parse(options.body);appendFileSync(process.env.TEST_CALLS,JSON.stringify(args)+'\\n');const result=JSON.parse(execFileSync('docker',['exec',process.env.TEST_CONTAINER,'redis-cli','--json',...args.map(String)],{encoding:'utf8'}));return Response.json({result});};`);
  const run=(mode:string,extra={})=>spawnSync(process.execPath,['--import',preload,'selfhost/mail-outbound-worker.mjs',mode],{env:{PATH:process.env.PATH,...env,CHAT_SMTP_PROFILE:config.smtpProfile,CHAT_MAIL_OUTBOUND_WORKER_ENABLED:'1',TEST_CONTAINER:container,TEST_CALLS:calls,...extra},encoding:'utf8',timeout:15000});
  const status=run('--status');expect(status.status,status.stderr).toBe(2);expect(JSON.parse(status.stdout)).toMatchObject({workerHealthy:false,uncertainCount:1,journalUncertainCount:1});
  const idle=run('--once');expect(idle.status,idle.stderr).toBe(2);expect(JSON.parse(idle.stdout)).toMatchObject({processed:0,uncertainCount:1});
  const paused={CHIRPY_MAIL_ENABLED:'0',CHAT_MAIL_OUTBOUND_WORKER_ENABLED:'0',CHIRPY_MAIL_IDENTITY_URL:'',CHIRPY_MAIL_IDENTITY_SECRET:''};
  const inspected=run('--inspect',paused);expect(inspected.status,inspected.stderr).toBe(0);expect(JSON.parse(inspected.stdout).items).toHaveLength(1);
  const reviewed=run('--review',paused);expect(reviewed.status,reviewed.stderr).toBe(0);expect(JSON.parse(reviewed.stdout)).toMatchObject({unresolved:1,reconciled:0,applied:false});
  const reconciled=run('--reconcile',paused);expect(reconciled.status,reconciled.stderr).toBe(0);expect(JSON.parse(reconciled.stdout)).toMatchObject({unresolved:1,reconciled:0,applied:true});
  expect(wire.state.connections).toBe(1);expect(wire.state.messages).toHaveLength(1);
  for(const op of readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse))expect(['EVAL','TIME','ZRANGEBYSCORE','ZRANGEBYLEX','GET','DEL']).toContain(op[0]);
  // Old pre-index journal holds still invalidate the remote healthy heartbeat.
  await redis(['DEL',queue+':uncertain']);
  const ledger=new DatabaseSync(env.CHAT_SMTP_JOURNAL_FILE);const aged=Date.now()-61000;
  ledger.prepare("UPDATE submissions SET created=?,updated=? WHERE state='uncertain'").run(aged,aged);ledger.close();
  const oldHold=run('--once');expect(oldHold.status,oldHold.stderr).toBe(2);expect(JSON.parse(oldHold.stdout)).toMatchObject({uncertainCount:0,journalStaleUncertainCount:1});
  expect((await createMailService(config,redis,request).workerStatus()).workerHealthy).toBe(false);
  // Failed scheduled startup clears liveness; failed read-only status does not.
  const heartbeat=config.prefix+'worker:last-success';await redis(['SET',heartbeat,String(Date.now())]);
  const wrong={CHAT_SMTP_PROFILE:'00'.repeat(32)};expect(run('--status',wrong).status).toBe(1);expect(await redis(['GET',heartbeat])).not.toBeNull();
  expect(run('--once',wrong).status).toBe(1);expect(await redis(['GET',heartbeat])).toBeNull();
 });

 it('explicitly restores legacy hold monitoring without changing receipts, retention or outcomes',async()=>{
  wire.state.mode='drop-ack';await service().execute(c);await service().drain();await redis(['DEL',queue+':uncertain']);
  const before=await redis(['GET',key]),ttl=await redis(['PTTL',key]);
  let cursor='0',reviewed=0;do{const page=await service().indexHolds({cursor});reviewed+=page.holds;cursor=page.cursor;}while(cursor!=='0');
  expect(reviewed).toBeGreaterThanOrEqual(1);expect(await redis(['ZCARD',queue+':uncertain'])).toBe(0);
  let indexed=0;do{const page=await service().indexHolds({cursor,apply:true});indexed+=page.indexed;cursor=page.cursor;}while(cursor!=='0');
  expect(indexed).toBe(1);expect(await redis(['GET',key])).toBe(before);expect(await redis(['PTTL',key])).toBeLessThanOrEqual(ttl);expect((await service().workerStatus()).workerHealthy).toBe(false);expect(wire.state.messages).toHaveLength(1);
  do{const page=await service().indexHolds({cursor,apply:true});expect(page.indexed).toBe(0);cursor=page.cursor;}while(cursor!=='0');
 });

 it.each(['wallet-shape','id-shape','key-mismatch'])('rejects corrupt %s before claiming or submitting a queued job',async kind=>{
  await service().execute(c);const j=await stored();if(kind==='wallet-shape')j.wallet=[j.wallet];if(kind==='id-shape')j.id=[j.id];if(kind==='key-mismatch')j.id='ff'.repeat(16);
  await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);const before=await redis(['GET',key]);
  await expect(service().drain()).rejects.toThrow('owner');expect(await redis(['GET',key])).toBe(before);expect(wire.state.connections).toBe(0);
 });
 it('atomically rejects an owner change between reading and claiming the same provider job',async()=>{
  await service().execute(c);const racing=service(async args=>{
   if(args[0]==='EVAL'&&args[1]===CLAIM_MAIL){const j=await stored();j.id='ff'.repeat(16);await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);}
   return redis(args);
  });
  await expect(racing.drain()).rejects.toThrow('claim');expect(await stored()).toMatchObject({status:'queued',attempts:0});expect(wire.state.connections).toBe(0);
 });

});
