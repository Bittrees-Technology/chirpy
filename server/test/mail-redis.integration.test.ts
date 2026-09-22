import { redirectFixture } from './helpers/mail-redirect-fixture.js';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { mailSignMessage } from '../../packages/core/src/mailAuth.js';
import { verifyMailCommand } from '../mail-service.js';
import { createMailService, mailConfig, bindingKey, hash, suppressionKey, suppressMailRecipient, optOutMail, mailOptoutKey } from '../mail-service.js';
import { APPLY_MAIL_EVENT } from '../mail-events.js';
import { ENQUEUE_MAIL, CLAIM_MAIL, FINISH_MAIL } from '../mail-store.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER;const exec=promisify(execFile);
const wallet=`0x${'3'.repeat(40)}`;
// Multi-step scenarios cross the Docker boundary for every Redis command.
describe.skipIf(!container)('real Redis email outbox',{timeout:30000},()=>{
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
  it('reports liveness and backlog without sending or changing the receipt or heartbeat',async()=>{
    let sends=0;const service=createMailService(config,redis,async()=>{sends++;throw Error('no send');});
    expect((await service.workerStatus()).workerHealthy).toBe(false);
    await service.drain();expect((await service.workerStatus()).workerHealthy).toBe(true);
    await service.execute(c);
    const heartbeat=`${config.prefix}worker:last-success`;
    const before=await redis(['GET',heartbeat]);const receipt=await redis(['GET',key]);const payload=await redis(['GET',`${key}:payload`]);
    const snapshot=await service.workerStatus();expect(snapshot).toMatchObject({queued:1,due:1,workerHealthy:true});
    expect(JSON.stringify(snapshot)).not.toContain(wallet);expect(JSON.stringify(snapshot)).not.toContain(c.to);
    expect(await redis(['GET',heartbeat])).toBe(before);expect(await redis(['GET',key])).toBe(receipt);expect(await redis(['GET',`${key}:payload`])).toBe(payload);expect(sends).toBe(0);
    await redis(['ZADD',queue,String(Date.now()-360000),key]);expect((await service.workerStatus()).workerHealthy).toBe(false);
    await redis(['ZADD',queue,String(Date.now()+360000),key]);
    for(const time of [Date.now()-360000,Date.now()+360000]) {await redis(['SET',heartbeat,String(time)]);expect((await service.workerStatus()).workerHealthy).toBe(false);}
  });
  it('does not record a successful tick when storage fails',async()=>{
    const service=createMailService(config,async(args)=>{if(args[0]==='ZRANGEBYSCORE')throw Error('storage down');return redis(args);});
    await expect(service.drain()).rejects.toThrow('storage down');
    expect((await service.workerStatus()).lastSuccessfulTickAt).toBeNull();
  });
  it('suppresses a recipient across wallets and case variants without expiry or quota charges',async()=>{
    await suppressMailRecipient(config,{email:c.to.toUpperCase(),reason:'opt-out',evidenceId:'synthetic-opt-out'},redis);
    const sk=suppressionKey(config,c.to);const stored=await redis(['GET',sk]);
    expect(stored).not.toContain(c.to);expect(await redis(['TTL',sk])).toBe(-1);
    await suppressMailRecipient(config,{email:c.to,reason:'bounce',evidenceId:'synthetic-bounce'},redis);expect(await redis(['GET',sk])).toBe(stored);
    for(const w of [wallet,`0x${'4'.repeat(40)}`]) {
      config.senders.push(w);await redis(['SET',bindingKey(config,w,c.to),JSON.stringify({...binding,wallet:w})]);
      expect((await createMailService(config,redis).execute({...c,wallet:w})).status).toBe('denied');expect(await redis(['GET',`${config.prefix}quota:wallet:${w}`])).toBeNull();
    }
    expect(await redis(['ZCARD',queue])).toBe(0);expect(await redis(['GET',`${key}:payload`])).toBeNull();
  });
  it.each(['enqueue','claim','handoff','legacy'])('blocks suppression racing with %s',async(boundary)=>{
    let sends=0;let applied=false;
    const suppress=async()=>{applied=true;await suppressMailRecipient(config,{email:c.to,reason:'complaint',evidenceId:'synthetic-complaint'},redis);};
    const racing=async(args)=>{
      if(!applied && ((boundary==='enqueue' && args[0]==='EVAL' && args[1]===ENQUEUE_MAIL) || (boundary==='claim' && args[0]==='EVAL' && args[1]===CLAIM_MAIL) || (boundary==='handoff' && args[0]==='EXISTS')))await suppress();
      return redis(args);
    };
    const service=createMailService(config,racing,async()=>{sends++;return {ok:true,json:async()=>({id:'unexpected'})};});
    const queued=await service.execute(c);
    if(boundary==='enqueue')expect(queued.status).toBe('denied');
    else {
      if(boundary==='legacy') {const j=await status();delete j.suppressionKey;await redis(['SET',key,JSON.stringify(j),'KEEPTTL']);await suppress();}
      // Re-importing a binding cannot cancel the recipient-wide suppression.
      await redis(['SET',bk,JSON.stringify(binding)]);
      await service.drain();expect((await status()).status).toBe('stopped');
      expect((await service.execute(c)).status).toBe('stopped');
    }
    expect(sends).toBe(0);expect(await redis(['GET',`${key}:payload`])).toBeNull();
  });
  it('atomically deduplicates provider suppression events and preserves existing opt-outs',async()=>{
    let sends=0;const service=createMailService(config,redis,async()=>{sends++;throw Error('must not send');});await service.execute(c);
    const ek=`${config.prefix}event:synthetic`;const sk=suppressionKey(config,c.to);const record=JSON.stringify({version:1,reason:'complaint',evidenceHash:hash('synthetic-event')});
    const apply=()=>redis(['EVAL',APPLY_MAIL_EVENT,'2',ek,sk,'digest',record]);
    expect((await Promise.all([apply(),apply()])).sort()).toEqual(['applied','duplicate']);
    expect(await redis(['TTL',sk])).toBe(-1);expect(await redis(['TTL',ek])).toBeGreaterThan(2591900);
    expect(await redis(['EVAL',APPLY_MAIL_EVENT,'2',ek,sk,'different',record])).toBe('conflict');
    const existing=await redis(['GET',sk]);await redis(['DEL',ek]);expect(await apply()).toBe('applied');expect(await redis(['GET',sk])).toBe(existing);
    await service.drain();expect(sends).toBe(0);expect((await status()).status).toBe('stopped');expect(await redis(['GET',`${key}:payload`])).toBeNull();
  });
  it('keeps recipient opt-out usable after delivery, payload deletion and encryption-key rotation',async()=>{
    let body='';let sends=0;
    const service=createMailService(config,redis,async(_url,options)=>{sends++;body=JSON.parse(options.body).text;return {ok:true,json:async()=>({id:'provider-optout'})};});
    await service.execute(c);await service.execute(c);
    expect([...keys].filter(k=>k.startsWith(`${config.prefix}optout:`))).toHaveLength(1);
    await service.drain();expect(await redis(['GET',`${key}:payload`])).toBeNull();
    const token=/#token=([a-f0-9]{64})/.exec(body)![1];
    expect(body).toContain('https://chirpy.test/mail/optout/#token=');
    const tokenKey=mailOptoutKey(config,token);expect(await redis(['GET',tokenKey])).toBe(suppressionKey(config,c.to));expect(await redis(['TTL',tokenKey])).toBe(-1);
    const next={...c,id:randomBytes(16).toString('hex')};await service.execute(next);
    const rotated={...config,key:Buffer.alloc(32,8)};
    expect(await optOutMail(rotated,token,redis)).toEqual({status:'opted-out'});expect(await optOutMail(rotated,token,redis)).toEqual({status:'opted-out'});
    await service.drain();expect(sends).toBe(1);expect((await service.execute({...next,action:'status'})).status).toBe('stopped');
    expect((await service.execute(c)).status).toBe('accepted');expect((await service.execute({...c,id:randomBytes(16).toString('hex')})).status).toBe('denied');
    expect(await optOutMail(config,'ff'.repeat(32),redis)).toEqual({status:'unknown'});
  });
  it('shares the recipient quota across verified address case variants',async()=>{
    const variant={...c,to:'RECIPIENT@example.com'};
    await redis(['SET',bindingKey(config,wallet,variant.to),JSON.stringify({...binding,email:variant.to})]);
    await redis(['SET',`${config.prefix}quota:email:${hash(c.to.toLowerCase())}`,'50','PX','86400000']);
    expect((await createMailService(config,redis).execute(variant)).status).toBe('limited');
    expect(await redis(['GET',key])).toBeNull();expect(await redis(['GET',`${key}:payload`])).toBeNull();
    expect(await redis(['GET',`${config.prefix}quota:wallet:${wallet}`])).toBeNull();
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
  it.each([307,308])('does not forward email through HTTP %i redirects and preserves a retryable job',async(code)=>{
    const fixture=await redirectFixture(code);
    try {
      const service=createMailService(config,redis,(_url,init)=>fetch(fixture.url,init));
      await service.execute(c);await service.drain();
      expect(fixture.requests()).toEqual(['/source']);
      expect((await status()).status).toBe('queued');
      expect(await redis(['GET',`${key}:payload`])).not.toBeNull();
    } finally { await fixture.close(); }
  });
  it('checks Wallet at enqueue and every retry using one immutable scope and provider key',async()=>{
    config.identity={url:'https://wallet.example/api/service/delivery',credential:'x'.repeat(32)};
    binding.identity={bindingId:'wallet-binding',version:1};await redis(['SET',bk,JSON.stringify(binding)]);
    const scopes:any[]=[],sends:any[]=[];
    const request=async(url,o)=>{
      if(url===config.identity.url){const scope=JSON.parse(o.body);scopes.push(scope);return Response.json({...scope,version:scope.expectedVersion,email:c.to,expiresAt:Date.now()+60000});}
      sends.push({key:o.headers['Idempotency-Key'],body:o.body});if(sends.length===1)throw Error('ack lost');return {ok:true,json:async()=>({id:'provider-wallet'})};
    };
    const service=createMailService(config,redis,request);expect((await service.execute(c)).status).toBe('queued');
    await service.drain();expect((await status()).status).toBe('queued');await readyAgain();await service.drain();
    expect(scopes).toHaveLength(3);for(const scope of scopes)expect(scope).toEqual(scopes[0]);
    expect(sends).toHaveLength(2);expect(sends[0]).toEqual(sends[1]);expect((await status()).status).toBe('accepted');
  });
  it.each(['revoked','mismatch','disabled','retargeted','suppressed','outage'])('blocks Wallet-scoped delivery after %s',async(kind)=>{
    config.identity={url:'https://wallet.example/api/service/delivery',credential:'x'.repeat(32)};
    binding.identity={bindingId:'wallet-binding',version:1};await redis(['SET',bk,JSON.stringify(binding)]);
    let phase='enqueue',sends=0;
    const request=async(url,o)=>{
      if(url!=='https://wallet.example/api/service/delivery'){sends++;return {ok:true,json:async()=>({id:'unexpected'})};}
      if(phase==='worker'){
        if(kind==='revoked')return new Response('',{status:403});
        if(kind==='outage')return new Response('',{status:503});
        if(kind==='suppressed')await suppressMailRecipient(config,{email:c.to,reason:'opt-out',evidenceId:'synthetic'},redis);
      }
      const scope=JSON.parse(o.body);return Response.json({...scope,version:scope.expectedVersion,email:phase==='worker'&&kind==='mismatch'?'other@example.com':c.to,expiresAt:Date.now()+60000});
    };
    const service=createMailService(config,redis,request);await service.execute(c);phase='worker';if(kind==='disabled')config.identity=null;if(kind==='retargeted')config.identity={...config.identity,url:'https://other.example/api/service/delivery'};
    await service.drain();expect(sends).toBe(0);expect((await status()).status).toBe(kind==='outage'?'queued':'stopped');
  });
  it('Wallet mode rejects unverified mappings and cannot upgrade an old queued job implicitly',async()=>{
    const service=createMailService(config,redis,async()=>{throw Error('must not contact provider');});await service.execute(c);
    config.identity={url:'https://wallet.example/api/service/delivery',credential:'x'.repeat(32)};
    expect((await service.execute({...c,id:'ef'.repeat(16)})).status).toBe('denied');
    await service.drain();expect((await status()).status).toBe('stopped');
  });
  it('one worker claims a job; acceptance purges content and preserves status',async()=>{
    const sent:any[]=[];const provider=async(_url,options)=>{sent.push(JSON.parse(options.body));await new Promise(r=>setTimeout(r,30));return {ok:true,json:async()=>({id:'provider-1'})};};
    const service=createMailService(config,redis,provider);await service.execute(c);
    await Promise.all([service.drain(),service.drain()]);
    expect(sent).toHaveLength(1);expect(sent[0].headers).toEqual({'X-Chat-Bridge':'wallet-to-email'});expect(sent[0].to).toEqual([c.to]);expect(sent[0].text).toContain(wallet);expect(sent[0].text).toContain(c.text);
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
    await readyAgain();await service.drain();expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);expect(JSON.parse(attempts[0].body).headers).toEqual({'X-Chat-Bridge':'wallet-to-email'});expect(seen.size).toBe(1);expect((await status()).status).toBe('accepted');
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
