import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { mailSignMessage } from '../../packages/core/src/mailAuth.js';
import { verifyMailCommand } from '../mail-service.js';
import { createMailService, mailConfig, bindingKey, hash } from '../mail-service.js';
import { ENQUEUE_MAIL, FINISH_MAIL } from '../mail-store.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER;const exec=promisify(execFile);
const wallet=`0x${'3'.repeat(40)}`;
describe.skipIf(!container)('real Redis email outbox',()=>{
  let config:any,c:any,binding:any,bk:string,key:string,queue:string;const keys=new Set<string>();
  const redis=async(args:any[])=>{
    if(args[0]==='SET')keys.add(args[1]);
    if(args[0]==='EVAL')args.slice(3,3+Number(args[2])).forEach(k=>keys.add(k));
    const {stdout}=await exec('docker',['exec',container!,'redis-cli','--json',...args.map(String)],{maxBuffer:2000000});
    const value=JSON.parse(stdout); if(typeof value==='string' && value.startsWith('ERR '))throw Error(value);return value;
  };
  beforeEach(async()=>{
    config=mailConfig({CHIRPY_MAIL_ENABLED:'1',CHIRPY_MAIL_SERVICE_URL:'https://chirpy.test/api/mail',KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'test',CHIRPY_MAIL_FROM:'service@example.com',CHIRPY_MAIL_SENDERS:wallet,CHIRPY_MAIL_DATA_KEY:'ab'.repeat(32),CHIRPY_MAIL_WORKER_SECRET:'test'.repeat(10),RESEND_API_KEY:'test'});
    config.prefix+=randomBytes(8).toString('hex')+':';
    c={action:'send',wallet,service:config.service,id:randomBytes(16).toString('hex'),expiresAt:Date.now()+60000,to:'recipient@example.com',subject:'Synthetic subject',text:'private body for encryption test'};
    binding={wallet,email:c.to,version:randomBytes(16).toString('hex'),revoked:false,verifiedAt:Date.now()-2000,consentedAt:Date.now()-1000,expiresAt:Date.now()+3600000,evidenceId:'synthetic-consent'};
    bk=bindingKey(config,wallet,c.to);key=`${config.prefix}job:${hash(`${wallet}\n${c.id}`)}`;queue=`${config.prefix}queue`;
    await redis(['SET',bk,JSON.stringify(binding)]);
  });
  afterEach(async()=>{if(keys.size)await redis(['DEL',...keys]);keys.clear();});
  const status=async()=>JSON.parse(await redis(['GET',key]));
  const readyAgain=async()=>{const j=await status();j.lockedUntil=0;await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);await redis(['ZADD',queue,'0',key]);};
  it('rejects authorization that expires between signature verification and the queue transaction',async()=>{
    const signer=privateKeyToAccount(`0x${'3'.repeat(64)}`);
    const expired={...c,wallet:signer.address.toLowerCase(),expiresAt:Date.now()-1};
    const signature=await signer.signMessage({message:mailSignMessage(expired)});
    // Verification succeeded at receipt time; the storage commit occurs later.
    expect(await verifyMailCommand(expired,signature,config.service,expired.expiresAt-1000)).toBe(true);
    config.senders.push(expired.wallet);
    const expiredBinding=bindingKey(config,expired.wallet,c.to);
    await redis(['SET',expiredBinding,JSON.stringify({...binding,wallet:expired.wallet})]);
    expect((await createMailService(config,redis).execute(expired)).status).toBe('expired');
    const expiredKey=`${config.prefix}job:${hash(`${expired.wallet}\n${expired.id}`)}`;
    for(const k of [expiredKey,`${expiredKey}:payload`,`${config.prefix}quota:wallet:${expired.wallet}`,`${config.prefix}quota:email:${hash(c.to)}`])expect(await redis(['GET',k])).toBeNull();
    expect(await redis(['ZCARD',queue])).toBe(0);
    const retry={...expired,expiresAt:Date.now()+60000};
    expect((await createMailService(config,redis).execute(retry)).status).toBe('queued');
  });
  it('queues atomically, encrypts payload, prevents changed-content reuse and charges quota once',async()=>{
    const service=createMailService(config,redis);
    const results=await Promise.all([service.execute(c),service.execute({...c,expiresAt:c.expiresAt+1})]);
    expect(results.map(r=>r.status)).toEqual(['queued','queued']);
    expect((await service.execute({...c,text:'different'})).status).toBe('conflict');
    expect(await redis(['GET',`${config.prefix}quota:wallet:${wallet}`])).toBe('1');
    expect(await redis(['GET',`${key}:payload`])).not.toContain(c.text);
    expect(await redis(['GET',key])).not.toContain(c.to);
  });
  it('one worker claims a job; acceptance purges content and preserves status',async()=>{
    const sent:any[]=[];const provider=async(_url,options)=>{sent.push(JSON.parse(options.body));await new Promise(r=>setTimeout(r,30));return {ok:true,json:async()=>({id:'provider-1'})};};
    const service=createMailService(config,redis,provider);await service.execute(c);
    await Promise.all([service.drain(),service.drain()]);
    expect(sent).toHaveLength(1);expect(sent[0].to).toEqual([c.to]);expect(sent[0].text).toContain(wallet);expect(sent[0].text).toContain(c.text);
    expect(await redis(['GET',`${key}:payload`])).toBeNull();expect((await status()).status).toBe('accepted');
    expect((await service.execute({...c,action:'status'})).status).toBe('accepted');
    expect((await service.execute({...c,action:'status',wallet:`0x${'4'.repeat(40)}`})).status).toBe('unknown');
  });
  it.each(['revoke','replace','expire'])('stops queued mail when authorization changes: %s',async(kind)=>{
    let calls=0;const service=createMailService(config,redis,async()=>{calls++;throw Error('must not send');});await service.execute(c);
    if(kind==='revoke')binding.revoked=true;else if(kind==='replace')binding.version=randomBytes(16).toString('hex');else binding.expiresAt=1;
    await redis(['SET',bk,JSON.stringify(binding)]);expect((await service.execute(c)).status).toBe('queued');await service.drain();
    expect(calls).toBe(0);expect((await status()).status).toBe('stopped');expect(await redis(['GET',`${key}:payload`])).toBeNull();
  });
  it('rechecks consent atomically when enqueue races with revocation',async()=>{
    const racing=async(args)=>{if(args[0]==='EVAL'&&args[1]===ENQUEUE_MAIL)await redis(['SET',bk,JSON.stringify({...binding,revoked:true})]);return redis(args);};
    expect((await createMailService(config,racing).execute(c)).status).toBe('denied');expect(await redis(['GET',key])).toBeNull();
  });
  it('blocks revocation after claim but before provider handoff',async()=>{
    let gets=0,calls=0;
    const boundary=async(args)=>{
      if(args[0]==='GET'&&args[1]===bk&&++gets===2)await redis(['SET',bk,JSON.stringify({...binding,revoked:true})]);
      return redis(args);
    };
    const service=createMailService(config,boundary,async()=>{calls++;throw Error('must not send');});
    await service.execute(c);await service.drain();expect(calls).toBe(0);expect((await status()).status).toBe('stopped');
  });
  it('retries a publish-before-ack crash with the same provider payload and idempotency key',async()=>{
    const seen=new Map();const attempts:any[]=[];let failAck=true;
    const provider=async(_url,o)=>{const id=o.headers['Idempotency-Key'];attempts.push({id,body:o.body});if(!seen.has(id))seen.set(id,'provider-id');return {ok:true,json:async()=>({id:seen.get(id)})};};
    const failing=async(args)=>{if(args[0]==='EVAL'&&args[1]===FINISH_MAIL&&failAck){failAck=false;throw Error('ack lost');}return redis(args);};
    const service=createMailService(config,failing,provider);await service.execute(c);await expect(service.drain()).rejects.toThrow('ack lost');
    await readyAgain();await service.drain();expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);expect(seen.size).toBe(1);expect((await status()).status).toBe('accepted');
  });
  it('bounds retries, enforces deadline and fails closed on wrong encryption keys',async()=>{
    let calls=0;const service=createMailService(config,redis,async()=>{calls++;return {ok:false,status:500};});await service.execute(c);
    for(let i=0;i<5;i++){await readyAgain();await service.drain();}
    expect(calls).toBe(5);expect((await status()).status).toBe('stopped');expect(await redis(['GET',`${key}:payload`])).toBeNull();
    c.id=randomBytes(16).toString('hex');key=`${config.prefix}job:${hash(`${wallet}\n${c.id}`)}`;await service.execute(c);const j=await status();j.deadline=1;await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);await service.drain();expect(calls).toBe(5);expect((await status()).status).toBe('stopped');
    c.id=randomBytes(16).toString('hex');key=`${config.prefix}job:${hash(`${wallet}\n${c.id}`)}`;await service.execute(c);await createMailService({...config,key:Buffer.alloc(32)},redis,async()=>{calls++;throw Error('no');}).drain();expect(calls).toBe(5);
  });
  it('enforces distributed wallet and recipient quotas and removes expired jobs from the index',async()=>{
    const service=createMailService(config,redis);
    for(let i=0;i<20;i++)expect((await service.execute({...c,id:randomBytes(16).toString('hex')})).status).toBe('queued');
    expect((await service.execute(c)).status).toBe('limited');
    await redis(['DEL',`${config.prefix}quota:wallet:${wallet}`]);await redis(['SET',`${config.prefix}quota:email:${hash(c.to)}`,'50']);expect((await service.execute(c)).status).toBe('limited');
    await redis(['ZADD',queue,'0',key]);await service.drain();expect(await redis(['ZSCORE',queue,key])).toBeNull();
  });
});
