import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {Webhook} from 'svix';
import {mailConfig,createMailService,bindingKey,suppressionKey,hash} from '../mail-service.js';
import {mailDeliveryKey} from '../mail-delivery.js';
import {handleMailEvent,APPLY_MAIL_EVENT} from '../mail-events.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER,exec=promisify(execFile),wallet='0x'+'3'.repeat(40),secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
describe.skipIf(!container)('real Redis provider delivery evidence',{timeout:30000},()=>{
 let env:any,config:any,c:any,key:string,recipientKey:string,deliveryKey:string;const keys=new Set<string>();
 const redis=async(args:any[])=>{
  if(args[0]==='SET')keys.add(args[1]);if(args[0]==='EVAL')args.slice(3,3+Number(args[2])).forEach(k=>keys.add(k));
  const {stdout}=await exec('docker',['exec',container!,'redis-cli','--json',...args.map(String)],{maxBuffer:2000000});const value=JSON.parse(stdout);if(typeof value==='string'&&value.startsWith('ERR '))throw Error(value);return value;
 };
 const apply=async(type:string,at=Date.now(),eventId=randomBytes(16).toString('hex'),patch={})=>{
  const body=JSON.stringify({type:'email.'+type,created_at:at?new Date(at).toISOString():undefined,data:{from:config.from,to:[c.to],email_id:'private-provider-id',subject:'private subject',...patch}});
  const date=new Date();return handleMailEvent(new Request('https://mail.test/api/mail-events',{method:'POST',body,headers:{'Content-Type':'application/json','svix-id':eventId,'svix-timestamp':String(Math.floor(date.getTime()/1000)),'svix-signature':new Webhook(secret).sign(eventId,date,body)}}),env,redis);
 };
 beforeEach(async()=>{
  env={CHIRPY_MAIL_ENABLED:'1',CHIRPY_MAIL_WEBHOOK_ENABLED:'1',RESEND_WEBHOOK_SECRET:secret,CHIRPY_MAIL_SERVICE_URL:`https://${randomBytes(8).toString('hex')}.mail.test/api/mail`,KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'test',CHIRPY_MAIL_FROM:'service@example.com',CHIRPY_MAIL_SENDERS:wallet,CHIRPY_MAIL_DATA_KEY:'ab'.repeat(32),CHIRPY_MAIL_WORKER_SECRET:'test'.repeat(10),RESEND_API_KEY:'test'};
  config=mailConfig(env);c={action:'send',wallet,service:config.service,id:randomBytes(16).toString('hex'),expiresAt:Date.now()+60000,to:'recipient@example.com',subject:'Synthetic subject',text:'Synthetic body'};
  key=`${config.prefix}job:${hash(`${wallet}\n${c.id}`)}`;recipientKey=suppressionKey(config,c.to);deliveryKey=mailDeliveryKey(config,'private-provider-id',recipientKey);
  const now=Date.now();await redis(['SET',bindingKey(config,wallet,c.to),JSON.stringify({wallet,email:c.to,version:'b'.repeat(32),revoked:false,verifiedAt:now-2000,consentedAt:now-1000,expiresAt:now+3600000,evidenceId:'synthetic'})]);
 });
 afterEach(async()=>{if(keys.size)await redis(['DEL',...keys]);keys.clear();});
 it('correlates a signed event arriving before the provider response without changing queue state',async()=>{
  let sends=0;const at=Date.now();const service=createMailService(config,redis,async()=>{
   sends++;expect((await apply('delivered',at)).status).toBe(200);expect(JSON.parse(await redis(['GET',key])).status).toBe('sending');
   return {ok:true,json:async()=>({id:'private-provider-id'})};
  });
  await service.execute(c);const ttl=await redis(['PTTL',key]);await service.drain();const raw=await redis(['GET',key]);
  const result=await service.execute({...c,action:'status'});expect(result).toMatchObject({status:'accepted',delivery:{version:1,events:[{type:'delivered',occurredAt:at}]}});
  expect(JSON.stringify(result)).not.toMatch(/private-provider|recipient@|private subject|suppressionKey/);expect(await redis(['GET',key])).toBe(raw);expect(await redis(['PTTL',key])).toBeLessThanOrEqual(ttl);expect(await redis(['GET',`${key}:payload`])).toBeNull();expect(sends).toBe(1);
  expect((await service.execute({...c,action:'status',wallet:'0x'+'4'.repeat(40)})).status).toBe('unknown');
 });
 it('preserves independent facts across out-of-order events and does not extend evidence retention',async()=>{
  const at=Date.now()-10000;await apply('delivered',at+2000);const ttl=await redis(['PTTL',deliveryKey]);
  for(const [type,time] of [['bounced',at+4000],['sent',at],['delivery_delayed',at+1000],['delivered',at+3000],['delivered',at+2000],['complained',at+5000],['failed',at+6000],['suppressed',at+7000]] as const)expect((await apply(type,time)).status).toBe(200);
  const evidence=JSON.parse(await redis(['GET',deliveryKey]));expect(evidence.events).toHaveLength(7);expect(evidence.events.find(e=>e.type==='delivered').occurredAt).toBe(at+3000);expect(evidence.events.some(e=>e.type==='bounced')).toBe(true);
  expect(await redis(['PTTL',deliveryKey])).toBeLessThanOrEqual(ttl);expect(await redis(['PTTL',recipientKey])).toBe(-1);expect(JSON.stringify(evidence)).not.toMatch(/private-provider|recipient@|private subject/);expect(await redis(['ZCARD',`${config.prefix}queue`])).toBe(0);
 });
 it('deduplicates exact signed events and refuses reused identities with changed scope or time',async()=>{
  const id='synthetic-id',at=Date.now()-1000;expect(await (await apply('delivered',at,id)).json()).toEqual({status:'applied'});const raw=await redis(['GET',deliveryKey]),ttl=await redis(['PTTL',deliveryKey]);
  expect(await (await apply('delivered',at,id)).json()).toEqual({status:'duplicate'});
  for(const [type,time,patch] of [['delivered',at+1,{}],['bounced',at,{}],['delivered',at,{to:['different@example.com']}]] as const)expect((await apply(type,time,id,patch)).status).toBe(409);
  expect(await redis(['GET',deliveryKey])).toBe(raw);expect(await redis(['PTTL',deliveryKey])).toBeLessThanOrEqual(ttl);expect(await redis(['GET',recipientKey])).toBeNull();
 });
 it('cannot attach another recipient or provider report, and never invents missing evidence',async()=>{
  const service=createMailService(config,redis,async()=>({ok:true,json:async()=>({id:'private-provider-id'})}));await service.execute(c);await service.drain();
  await apply('delivered',Date.now(),'wrong-recipient',{to:['different@example.com']});await apply('delivered',Date.now(),'wrong-provider',{email_id:'other-provider'});
  expect((await service.execute({...c,action:'status'})).delivery).toEqual({version:1,events:[]});
  await apply('delivered');expect((await service.execute({...c,action:'status'})).delivery.events).toHaveLength(1);
  await redis(['DEL',deliveryKey]);expect((await service.execute({...c,action:'status'})).delivery.events).toHaveLength(0);
 });
 it('preserves legacy suppression and adds evidence on a replay without extending old markers',async()=>{
  const id='legacy-id',at=Date.now()-1000,eventKey=`${config.prefix}event:${hash(id)}`,digest=hash(JSON.stringify(['email.bounced','private-provider-id',config.from,c.to]));
  await redis(['EVAL',APPLY_MAIL_EVENT,'2',eventKey,recipientKey,digest,JSON.stringify({version:1,reason:'bounce',evidenceHash:hash(id)})]);const ttl=await redis(['PTTL',eventKey]);
  expect((await apply('bounced',at,id)).status).toBe(200);expect(await redis(['PTTL',eventKey])).toBeLessThanOrEqual(ttl);expect(JSON.parse(await redis(['GET',deliveryKey])).events).toEqual([{type:'bounced',occurredAt:at}]);
  expect((await apply('complained',at,id)).status).toBe(409);
 });
 it('still suppresses legacy untimed reports and damaged delivery evidence without granting sends',async()=>{
  expect((await apply('bounced',0)).status).toBe(200);expect(await redis(['GET',recipientKey])).not.toBeNull();expect(await redis(['GET',deliveryKey])).toBeNull();
  await redis(['DEL',recipientKey]);await redis(['SET',deliveryKey,'{"version":99,"events":[]}','PX','60000']);expect((await apply('complained')).status).toBe(503);expect(await redis(['GET',recipientKey])).not.toBeNull();expect(await redis(['PTTL',recipientKey])).toBe(-1);
 });
});
