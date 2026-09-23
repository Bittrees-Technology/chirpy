import {readInboundHistory,inboundHistoryOwner,inboundHistoryKey} from '../inbound-history.js';
import {INBOUND_HISTORY_SERVICE} from '../../packages/core/src/inboundHistory.js';
import {CLAIM_INBOUND_JOB,FINISH_INBOUND_JOB} from '../inbound-queue-store.js';
import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { hash } from '../mail-service.js';
import { inboundMailConfig,enqueueInboundMail,decodeInboundMail,ENQUEUE_INBOUND_MAIL } from '../inbound-mail.js';
import { inboundMailScope,inboundMailId } from '../inbound-mail-contract.js';
import { inboundEnv,inboundEvent,identityResponse } from './helpers/inbound-mail-fixture.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER,exec=promisify(execFile);
describe.skipIf(!container)('real Redis inbound queue',{timeout:30000},()=>{
 let config:any,event:any,scope:any,key:string;const keys=new Set<string>();
 const redis=async(args:any[])=>{if(args[0]==='SET')keys.add(args[1]);if(args[0]==='EVAL')args.slice(3,3+Number(args[2])).forEach(k=>keys.add(k));const {stdout}=await exec('docker',['exec',container!,'redis-cli','--json',...args.map(String)]);if(stdout.trimStart().startsWith('error:'))throw Error(JSON.parse(stdout.trimStart().slice(6)));const value=JSON.parse(stdout);if(typeof value==='string'&&value.startsWith('ERR '))throw Error(value);return value;};
 const identity=async(_url,o)=>identityResponse(JSON.parse(o.body));
 beforeEach(()=>{config=inboundMailConfig(inboundEnv);config.prefix+=randomBytes(8).toString('hex')+':';event=inboundEvent();scope=inboundMailScope(event);key=config.prefix+'job:'+scope.deliveryId;});
 afterEach(async()=>{if(keys.size)await redis(['DEL',...keys]);keys.clear();});
 it('atomically deduplicates concurrent retries and encrypts all content and recipient data',async()=>{
  const results=await Promise.all(Array.from({length:4},()=>enqueueInboundMail(config,{event,scope},redis,identity)));expect(results.every(r=>r.status==='queued')).toBe(true);
  expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(1);
  const metadata=await redis(['GET',key]),ciphertext=await redis(['GET',key+':payload']);
  for(const privateValue of [event.mailbox,event.from,event.subject,event.text,'0x'+'3'.repeat(40)]){expect(metadata).not.toContain(privateValue);expect(ciphertext).not.toContain(privateValue);}
  const decoded=decodeInboundMail(config,ciphertext,key);expect(decoded.event).toEqual(event);expect(decoded.scope).toEqual(scope);expect(decoded.recipient.wallet).toBe('0x'+'3'.repeat(40));
  expect(()=>decodeInboundMail({...config,key:Buffer.alloc(32)},ciphertext,key)).toThrow();expect(()=>decodeInboundMail(config,ciphertext,key+'wrong')).toThrow();
  expect(await redis(['GET',config.prefix+'quota:all'])).toBe('1');
  expect(await redis(['PTTL',key+':payload'])).toBeLessThanOrEqual(60000);
 });
 it('preserves the exact receipt after a lost acknowledgement and denies changed content',async()=>{
  let fail=true;const lost=async(args)=>{const result=await redis(args);if(fail&&args[0]==='EVAL'){fail=false;throw Error('lost ack');}return result;};
  await expect(enqueueInboundMail(config,{event,scope},lost,identity)).rejects.toThrow('lost ack');
  const original=await redis(['GET',key]);
  expect((await enqueueInboundMail(config,{event,scope},redis,async()=>{throw Error('duplicate must not reauthorize');})).status).toBe('queued');expect(await redis(['GET',key])).toBe(original);
  const changed={...event,text:'changed'};expect((await enqueueInboundMail(config,{event:changed,scope:inboundMailScope(changed)},redis,identity)).status).toBe('conflict');expect(await redis(['GET',key])).toBe(original);
 });
 it('rechecks deadline at atomic commit and refuses expired authorization without writing',async()=>{
  const delayed=async(args)=>{if(args[0]==='EVAL'&&args[1]===ENQUEUE_INBOUND_MAIL)args[args.length-1]='1';return redis(args);};
  expect((await enqueueInboundMail(config,{event,scope},delayed,identity)).status).toBe('expired');expect(await redis(['GET',key])).toBeNull();expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(0);
 });
 it('enforces bounded global intake and leaves rejected message bodies out of storage',async()=>{
  await redis(['SET',config.prefix+'quota:all','1000']);expect((await enqueueInboundMail(config,{event,scope},redis,identity)).status).toBe('limited');expect(await redis(['GET',key+':payload'])).toBeNull();
 });
 it('enforces the mailbox limit atomically across concurrent messages',async()=>{
  await redis(['SET',config.prefix+'quota:'+hash(event.mailbox.toLowerCase()),'199']);
  const next={...event,messageId:'56'.repeat(32),id:inboundMailId(event.mailbox,'56'.repeat(32))};
  const results=await Promise.all([event,next].map(e=>enqueueInboundMail(config,{event:e,scope:inboundMailScope(e)},redis,identity)));
  expect(results.map(r=>r.status).sort()).toEqual(['limited','queued']);expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(1);
 });
 it('keeps private wallet history after payload deletion without changing publication or retention',async()=>{
  await enqueueInboundMail(config,{event,scope},redis,identity);const c={action:'history',service:INBOUND_HISTORY_SERVICE,wallet:'0x'+'3'.repeat(40),id:'a'.repeat(32),cursor:null,expiresAt:Date.now()+300000};
  const first=await readInboundHistory(config,c,redis);expect(first.records).toHaveLength(1);expect(first.records[0]).toMatchObject({id:event.id,status:'queued',attempts:0});expect(JSON.stringify(first)).not.toMatch(/member@example|Person|Private text|binding-1|historyOwner/);
  const ttl=await redis(['PTTL',key]);await redis(['EVAL',CLAIM_INBOUND_JOB,'1',config.prefix+'queue',config.prefix+'job:','token']);expect((await readInboundHistory(config,c,redis)).records[0]).toMatchObject({status:'sending',attempts:1});
  await redis(['EVAL',FINISH_INBOUND_JOB,'3',key,key+':payload',config.prefix+'queue','token','published','f'.repeat(64)]);expect(await redis(['GET',key+':payload'])).toBeNull();
  const raw=await redis(['GET',key]);expect((await readInboundHistory(config,c,redis)).records[0].status).toBe('published');expect(await redis(['GET',key])).toBe(raw);expect(await redis(['PTTL',key])).toBeLessThanOrEqual(ttl);expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(0);
  expect((await readInboundHistory(config,{...c,wallet:'0x'+'4'.repeat(40)},redis)).records).toEqual([]);expect((await readInboundHistory(config,{...c,expiresAt:Date.now()-1},redis)).status).toBe('expired');
 });
 it('paginates tied timestamps privately and omits legacy, expired and foreign records',async()=>{
  const wallet='0x'+'3'.repeat(40),owner=inboundHistoryOwner(config,wallet),index=inboundHistoryKey(config,owner),createdAt=Date.now()-1000,expected=new Set<string>();
  for(let i=0;i<28;i++){
   const id=i.toString(16).padStart(64,'0'),k=config.prefix+'job:'+id;expected.add(id);await redis(['SET',k,JSON.stringify({id,historyOwner:owner,createdAt,updatedAt:null,deadline:createdAt+60000,status:'queued',attempts:0}),'PX','60000']);keys.add(index);await redis(['ZADD',index,createdAt,k]);
  }
  const c={action:'history',service:INBOUND_HISTORY_SERVICE,wallet,id:'a'.repeat(32),cursor:null,expiresAt:Date.now()+300000};
  const first=await readInboundHistory(config,c,redis),second=await readInboundHistory(config,{...c,cursor:first.nextCursor},redis);expect(first.records).toHaveLength(25);expect(second.records).toHaveLength(3);expect(new Set([...first.records,...second.records].map(r=>r.id))).toEqual(expected);
  expect((await readInboundHistory(config,{...c,wallet:'0x'+'4'.repeat(40),cursor:first.nextCursor},redis)).status).toBe('history-changed');
  await redis(['SET',key,JSON.stringify({id:event.id,createdAt,deadline:createdAt+60000,status:'queued',attempts:0}),'PX','60000']);expect((await readInboundHistory(config,c,redis)).records).toHaveLength(25);
  await redis(['ZADD',index,createdAt+1,key]);await expect(readInboundHistory(config,c,redis)).rejects.toThrow('owner');await redis(['DEL',key]);expect((await readInboundHistory(config,c,redis)).records).toHaveLength(24);
 });
 it('caps the owner index while retaining the new job and queue entry',async()=>{
  const owner=inboundHistoryOwner(config,'0x'+'3'.repeat(40)),index=inboundHistoryKey(config,owner),now=Date.now()-10000;
  await redis(['EVAL',"for i=1,32000 do redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2]..string.format('%064x',i)) end return redis.call('ZCARD',KEYS[1])",'1',index,String(now),config.prefix+'job:']);
  await enqueueInboundMail(config,{event,scope},redis,identity);expect(await redis(['ZCARD',index])).toBe(32000);expect(await redis(['ZSCORE',index,key])).not.toBeNull();expect(await redis(['GET',key])).not.toBeNull();expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(1);
 });
 it('rejects a damaged history index before committing any new queue state',async()=>{
  const index=inboundHistoryKey(config,inboundHistoryOwner(config,'0x'+'3'.repeat(40)));await redis(['SET',index,'damaged']);await expect(enqueueInboundMail(config,{event,scope},redis,identity)).rejects.toThrow('Invalid history index');
  expect(await redis(['GET',key])).toBeNull();expect(await redis(['GET',key+':payload'])).toBeNull();expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(0);expect(await redis(['GET',config.prefix+'quota:all'])).toBeNull();
 });
 it('does not collapse two messages or claim that queueing publishes a wallet message',async()=>{
  const next={...event,messageId:'34'.repeat(32),id:inboundMailId(event.mailbox,'34'.repeat(32))};
  for(const e of [event,next])expect((await enqueueInboundMail(config,{event:e,scope:inboundMailScope(e)},redis,identity)).status).toBe('queued');
  expect(await redis(['ZCARD',config.prefix+'queue'])).toBe(2);
 });
});
