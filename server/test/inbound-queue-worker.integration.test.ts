import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {hash} from '../mail-service.js';
import {inboundMailConfig,enqueueInboundMail} from '../inbound-mail.js';
import {inboundMailScope,inboundMailText} from '../inbound-mail-contract.js';
import {InboundSendJournal,guardedInboundSend} from '../inbound-send-journal.js';
import {inboundSenderIdentity} from '../inbound-xmtp-sender.js';
import {runInboundMailJob} from '../inbound-queue-worker.js';
import {FINISH_INBOUND_JOB} from '../inbound-queue-store.js';
import {inboundEnv,inboundEvent,identityResponse} from './helpers/inbound-mail-fixture.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER,exec=promisify(execFile);
describe.skipIf(!container)('real Redis inbound worker',{timeout:30000},()=>{
 let root:string,config:any,childConfig:any,journal:any,event:any,scope:any,key:string,settings:any,dependencies:any,sends:number;
 const keys=new Set<string>();
 const redis=async(args:any[])=>{
  if(['SET','ZADD'].includes(args[0]))keys.add(args[1]);
  if(args[0]==='EVAL')args.slice(3,3+Number(args[2])).forEach(k=>keys.add(k));
  const {stdout}=await exec('docker',['exec',container!,'redis-cli','--json',...args.map(String)]);
  const value=JSON.parse(stdout);if(typeof value==='string'&&value.startsWith('ERR '))throw Error(value);return value;
 };
 const recipient=()=>({wallet:'0x'+'3'.repeat(40),expiresAt:Date.now()+60000});
 const sendScope=()=>({eventId:event.id,contentHash:scope.contentHash,recipientHash:hash(recipient().wallet),textHash:hash(inboundMailText(event))});
 const receipt=()=>({messageId:'12'.repeat(32),conversationId:'34'.repeat(16),senderInboxId:childConfig.inboxId,textHash:sendScope().textHash});
 const job=async()=>JSON.parse(await redis(['GET',key]));
 const updateJob=async(patch)=>redis(['SET',key,JSON.stringify({...await job(),...patch}),'KEEPTTL']);
 const due=()=>redis(['ZADD',config.prefix+'queue','0',key]);
 beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),'chat-inbound-worker-'));
  config=inboundMailConfig(inboundEnv);config.prefix+=randomBytes(8).toString('hex')+':';
  childConfig={enabled:true,network:'dev',address:'0x'+'1'.repeat(40),inboxId:'ab'.repeat(32),installationId:'cd'.repeat(32),databaseKey:'ef'.repeat(32),directory:join(root,'bridge'),identity:config.identity,source:{}};
  journal=InboundSendJournal.provision(childConfig.directory,inboundSenderIdentity(childConfig));
  event=inboundEvent();scope=inboundMailScope(event);key=config.prefix+'job:'+scope.deliveryId;sends=0;
  await enqueueInboundMail(config,{event,scope},redis,async(_url,o)=>identityResponse(JSON.parse(o.body)));
  settings={config,journal,childConfig,processConfig:{node:process.execPath,script:'/unused',config:'/unused'}};
  dependencies={storage:redis,sourceCheck:vi.fn(async()=>true),recipientCheck:vi.fn(async()=>recipient()),
   send:vi.fn(async(j)=>guardedInboundSend(j,sendScope(),async()=>{sends++;return receipt();}))};
 });
 afterEach(async()=>{try{journal.close();}catch{};if(keys.size)await redis(['DEL',...keys]);keys.clear();rmSync(root,{recursive:true,force:true});});
 it('publishes once under concurrent workers and stores only a receipt hash without extending retention',async()=>{
  const before=await redis(['PTTL',key]);
  const other=new InboundSendJournal(childConfig.directory,inboundSenderIdentity(childConfig));
  try{const results=await Promise.all([runInboundMailJob(settings,dependencies),runInboundMailJob({...settings,journal:other},dependencies)]);expect(results.map(r=>r.status).sort()).toEqual(['idle','published']);}finally{other.close();}
  expect(sends).toBe(1);expect((await job()).publicationHash).toBe(hash(JSON.stringify(receipt())));
  expect(await redis(['GET',key+':payload'])).toBeNull();expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(0);expect(await redis(['PTTL',key])).toBeLessThanOrEqual(before);
  const metadata=await redis(['GET',key]);for(const value of [event.mailbox,event.text,recipient().wallet,receipt().conversationId])expect(metadata).not.toContain(value);
 });
 it('recovers a published local receipt after a lost queue write, even without an unexpired payload',async()=>{
  let fail=true;const storage=async args=>{if(args[0]==='EVAL'&&args[1]===FINISH_INBOUND_JOB&&fail){fail=false;throw Error('lost queue write');}return redis(args);};
  await expect(runInboundMailJob(settings,{...dependencies,storage})).rejects.toThrow();expect(sends).toBe(1);
  await updateJob({leaseUntil:1,deadline:1});await due();await redis(['DEL',key+':payload']);
  dependencies.sourceCheck.mockImplementation(async()=>{throw Error('must not reauthorize a completed publication');});
  expect((await runInboundMailJob(settings,dependencies)).status).toBe('published');expect(sends).toBe(1);expect(dependencies.send).toHaveBeenCalledTimes(1);
 });
 it('never resends an armed attempt after lease expiry and retains its guard',async()=>{
  journal.begin(sendScope());await updateJob({status:'sending',token:'old',leaseUntil:1});await due();
  expect((await runInboundMailJob(settings,dependencies)).status).toBe('uncertain');expect(dependencies.send).not.toHaveBeenCalled();expect(journal.inspect().blocked).toBe(true);
  expect(await redis(['GET',key+':payload'])).not.toBeNull();expect((await runInboundMailJob(settings,dependencies)).status).toBe('idle');
 });
 it('retries transient preflight failure without arming, then sends once when authority recovers',async()=>{
  dependencies.sourceCheck.mockRejectedValueOnce(Error('unavailable'));
  const before=await redis(['PTTL',key+':payload']);
  expect((await runInboundMailJob(settings,dependencies)).status).toBe('queued');expect(journal.outcome(event.id,scope.contentHash).status).toBe('missing');expect(sends).toBe(0);
  expect(Number(await redis(['ZSCORE',config.prefix+'queue',key]))).toBeGreaterThan(Date.now());expect(await redis(['PTTL',key+':payload'])).toBeLessThanOrEqual(before);
  await due();expect((await runInboundMailJob(settings,dependencies)).status).toBe('published');expect(sends).toBe(1);
 });
 it.each(['expired','revoked','retargeted','ciphertext','service'])('stops %s work before SDK launch',async reason=>{
  if(reason==='expired')await updateJob({deadline:1});
  if(reason==='revoked')dependencies.sourceCheck.mockResolvedValue(false);
  if(reason==='retargeted')dependencies.recipientCheck.mockResolvedValue({...recipient(),wallet:'0x'+'9'.repeat(40)});
  if(reason==='ciphertext')await redis(['SET',key+':payload','corrupt','KEEPTTL']);
  if(reason==='service')await updateJob({identityService:'https://other.example/api/service/inbound'});
  expect((await runInboundMailJob(settings,dependencies)).status).toBe('stopped');expect(dependencies.send).not.toHaveBeenCalled();expect(journal.inspect().blocked).toBe(false);expect(await redis(['GET',key+':payload'])).toBeNull();
 });
 it('fences a worker that loses its claim during preflight',async()=>{
  let oldToken;
  dependencies.sourceCheck.mockImplementation(async()=>{oldToken=(await job()).token;await updateJob({token:'replacement'});return true;});
  expect((await runInboundMailJob(settings,dependencies)).status).toBe('superseded');expect(dependencies.send).not.toHaveBeenCalled();
  expect(await redis(['EVAL',FINISH_INBOUND_JOB,'3',key,key+':payload',config.prefix+'queue',oldToken,'published','fake'])).toBe('superseded');expect((await job()).status).toBe('sending');
 });
 it('refuses a reported success without durable publication evidence',async()=>{
  dependencies.send.mockResolvedValue({status:'published',receipt:receipt()});
  expect((await runInboundMailJob(settings,dependencies)).status).toBe('uncertain');expect((await job()).publicationHash).toBeUndefined();
 });
 it('runs the real sender process and quarantines a disabled child without retrying',async()=>{
  const path=join(root,'sender.json');writeFileSync(path,JSON.stringify({...childConfig,enabled:false}),{mode:0o600});
  settings.processConfig={node:process.execPath,script:fileURLToPath(new URL('../inbound-sender-child.js',import.meta.url)),config:path};
  const {send,...real}=dependencies;
  expect((await runInboundMailJob(settings,real)).status).toBe('uncertain');expect(journal.inspect().blocked).toBe(true);expect((await runInboundMailJob(settings,real)).status).toBe('idle');
 });
 it('removes orphaned queue references without deleting keys outside its namespace',async()=>{
  const outside=config.prefix+'outside';await redis(['SET',outside,'preserve']);
  await redis(['ZADD',config.prefix+'queue','-2',outside,'-1',config.prefix+'job:'+'99'.repeat(32)]);
  expect((await runInboundMailJob(settings,dependencies)).status).toBe('published');expect(await redis(['GET',outside])).toBe('preserve');expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(0);
 });
});
