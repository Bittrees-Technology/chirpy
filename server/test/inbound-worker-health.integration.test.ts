import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {InboundSendJournal} from '../inbound-send-journal.js';
import {recordInboundWorkerTick,inspectInboundWorker} from '../inbound-worker-health.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER,exec=promisify(execFile);
describe.skipIf(!container)('real Redis worker health',{timeout:30000},()=>{
 let root:string,journal:any,config:any;const keys=new Set<string>();
 const redis=async(args:any[])=>{
  if(['SET','ZADD'].includes(args[0]))keys.add(args[1]);if(args[0]==='EVAL')args.slice(3,3+Number(args[2])).forEach(k=>keys.add(k));
  const {stdout}=await exec('docker',['exec',container!,'redis-cli','--json',...args.map(String)]);const value=JSON.parse(stdout);if(typeof value==='string'&&value.startsWith('ERR '))throw Error(value);return value;
 };
 const scope={eventId:'ab'.repeat(32),contentHash:'cd'.repeat(32),recipientHash:'ef'.repeat(32),textHash:'12'.repeat(32)};
 beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'chat-worker-health-'));journal=InboundSendJournal.provision(join(root,'bridge'),'34'.repeat(32));config={prefix:'chat:test:health:'+randomBytes(8).toString('hex')+':'};});
 afterEach(async()=>{journal.close();if(keys.size)await redis(['DEL',...keys]);keys.clear();rmSync(root,{recursive:true,force:true});});
 const inspect=()=>inspectInboundWorker(config,journal,redis);
 const addJob=async(patch={})=>{const key=config.prefix+'job:'+'56'.repeat(32);await redis(['SET',key,JSON.stringify({id:scope.eventId,status:'queued',createdAt:Date.now(),deadline:Date.now()+60000,...patch})]);await redis(['ZADD',config.prefix+'queue',0,key]);return key;};
 it('does not claim health before a successful tick and does not refresh heartbeat on inspection',async()=>{
  expect((await inspect()).status).toBe('degraded');expect(await redis(['GET',config.prefix+'worker'])).toBeNull();
  await recordInboundWorkerTick(config,'idle',false,redis);const before=await redis(['GET',config.prefix+'worker']);
  expect((await inspect()).status).toBe('healthy');expect(await redis(['GET',config.prefix+'worker'])).toBe(before);
 });
 it('preserves last success after failure and exposes degraded health without private details',async()=>{
  await recordInboundWorkerTick(config,'published',false,redis);const prior=JSON.parse(await redis(['GET',config.prefix+'worker']));
  await recordInboundWorkerTick(config,'error',false,redis);const h=await inspect();
  expect(h.status).toBe('degraded');expect(h.worker.lastSuccessAt).toBe(prior.lastSuccessAt);expect(h.worker.lastOutcome).toBe('error');
  await addJob({mailbox:'private@example.com',text:'private body'});expect(JSON.stringify(await inspect())).not.toContain('private');
 });
 it('detects stopped scheduling even with an empty queue',async()=>{
  const past=Date.now()-360000;await redis(['SET',config.prefix+'worker',JSON.stringify({lastAttemptAt:past,lastSuccessAt:past,lastOutcome:'idle',successful:true})]);
  const h=await inspect();expect(h.queue.pending).toBe(0);expect(h.status).toBe('degraded');
 });
 it('distinguishes a live claimed send from uncertainty after its lease expires',async()=>{
  await recordInboundWorkerTick(config,'idle',false,redis);journal.begin(scope);
  const key=await addJob({status:'sending',leaseUntil:Date.now()+60000});
  const live=await inspect();expect(live.sender).toEqual({guarded:true,uncertain:false});expect(live.status).toBe('healthy');
  const job=JSON.parse(await redis(['GET',key]));job.leaseUntil=1;await redis(['SET',key,JSON.stringify(job)]);
  const stale=await inspect();expect(stale.sender.uncertain).toBe(true);expect(stale.queue.staleClaims).toBe(1);expect(stale.status).toBe('degraded');expect(journal.outcome(scope.eventId,scope.contentHash).status).toBe('uncertain');
 });
 it('reports a quarantined guard even after its job leaves the queue',async()=>{
  await recordInboundWorkerTick(config,'idle',false,redis);journal.begin(scope);
  expect((await inspect()).sender).toEqual({guarded:true,uncertain:true});expect((await inspect()).status).toBe('degraded');
 });
 it('reports aged, expired and corrupt queue state without changing any entries',async()=>{
  await recordInboundWorkerTick(config,'idle',false,redis);const key=await addJob({createdAt:Date.now()-360000,deadline:1});
  const corrupt=config.prefix+'job:'+'78'.repeat(32);await redis(['SET',corrupt,'malformed']);await redis(['ZADD',config.prefix+'queue',0,corrupt,0,'foreign-key']);
  const h=await inspect();expect(h.status).toBe('degraded');expect(h.queue.expired).toBe(1);expect(h.queue.corrupt).toBe(2);expect(h.queue.oldestAgeMs).toBeGreaterThanOrEqual(360000);
  expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(3);expect(await redis(['GET',corrupt])).toBe('malformed');expect(await redis(['GET',key])).not.toBeNull();
 });
 it('bounds scanning to 1000 entries and reports overflow',async()=>{
  await recordInboundWorkerTick(config,'idle',false,redis);
  const args:any[]=['ZADD',config.prefix+'queue'];for(let i=0;i<1001;i++)args.push(i,config.prefix+'job:'+i.toString(16).padStart(64,'0'));await redis(args);
  const h=await inspect();expect(h.queue.pending).toBe(1001);expect(h.queue.orphaned).toBe(1000);expect(h.status).toBe('degraded');
 });
 it('rejects forged future heartbeat freshness and never treats retrying or blocked ticks as success',async()=>{
  const future=Date.now()+360000;await redis(['SET',config.prefix+'worker',JSON.stringify({lastAttemptAt:future,lastSuccessAt:future,lastOutcome:'idle',successful:true})]);
  expect((await inspect()).status).toBe('degraded');
  await recordInboundWorkerTick(config,'queued',false,redis);expect((await inspect()).worker.lastSuccessAt).toBeNull();
  await recordInboundWorkerTick(config,'idle',true,redis);expect((await inspect()).worker.lastSuccessAt).toBeNull();
 });
});
