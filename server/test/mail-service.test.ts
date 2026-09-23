import { redirectFixture } from './helpers/mail-redirect-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { mailConfig, validMailCommand, verifyMailCommand, validMailBinding, suppressMailRecipient, mailKv, createMailService, hash } from '../mail-service.js';
import { mailSignMessage } from '../../packages/core/src/mailAuth.js';
import handler from '../../api/mail.js';
import worker from '../../api/mail-worker.js';
const wallet=privateKeyToAccount(`0x${'3'.repeat(64)}`);
const env={CHIRPY_MAIL_ENABLED:'1',CHIRPY_MAIL_SERVICE_URL:'https://chirpy.example/api/mail',KV_REST_API_URL:'https://kv.example',KV_REST_API_TOKEN:'synthetic',CHIRPY_MAIL_FROM:'service@example.com',CHIRPY_MAIL_SENDERS:wallet.address,CHIRPY_MAIL_DATA_KEY:'ab'.repeat(32),CHIRPY_MAIL_WORKER_SECRET:'test'.repeat(10),RESEND_API_KEY:'synthetic'};
const command=()=>({action:'send',service:env.CHIRPY_MAIL_SERVICE_URL,wallet:wallet.address.toLowerCase(),id:'ab'.repeat(16),expiresAt:Date.now()+60000,to:'member@example.com',subject:'A private message',text:'Hello'});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
function res(){return {code:0,body:null as any,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}
describe('wallet email authorization',()=>{
  it.each([307,308])('does not forward storage commands through HTTP %i redirects',async(code)=>{
    const fixture=await redirectFixture(code);
    try {
      const config=mailConfig(env)!;
      const kv=mailKv(config,(_url,init)=>fetch(fixture.url,init));
      await expect(kv(['SET','synthetic-private-key','synthetic-private-value'])).rejects.toThrow();
      expect(fixture.requests()).toEqual(['/source']);
    } finally { await fixture.close(); }
  });
  it('fails closed without complete explicit configuration',()=>{
    expect(mailConfig({})).toBeNull(); expect(mailConfig(env)).not.toBeNull(); expect(mailConfig({...env,VERCEL_ENV:'preview'})).toBeNull();
    for(const key of Object.keys(env)) expect(mailConfig({...env,[key]:''})).toBeNull();
    expect(mailConfig({...env,CHIRPY_MAIL_SERVICE_URL:'https://user:secret@chirpy.example/api/mail'})).toBeNull();
    expect(mailConfig({...env,CHIRPY_MAIL_SERVICE_URL:'https://chirpy.example/api/mail?spoof=1'})).toBeNull();
    const partial={...env,CHIRPY_MAIL_IDENTITY_URL:'https://wallet.example/api/service/delivery'};
    expect(mailConfig(partial)).toBeNull();
    // Suppression and opt-out must work even when forwarding configuration is broken.
    expect(mailConfig(partial,{deliveryIdentity:false})).not.toBeNull();
  });
  it('binds the wallet signature to service, recipient, content, ID and expiry',async()=>{
    const c=command();const sig=await wallet.signMessage({message:mailSignMessage(c)});
    expect(await verifyMailCommand(c,sig,c.service)).toBe(true);
    for(const patch of [{service:'https://other.example/api/mail'},{to:'other@example.com'},{text:'changed'},{subject:'changed'},{id:'cd'.repeat(16)},{wallet:`0x${'1'.repeat(40)}`},{action:'status'},{expiresAt:c.expiresAt+1}]) expect(await verifyMailCommand({...c,...patch},sig,c.service)).toBe(false);
    expect(await verifyMailCommand(c,sig,c.service,c.expiresAt)).toBe(false);
  });
  it.each([{to:'a@example.com\r\nBcc:b@example.com'},{to:'a@example.com,b@example.com'},{subject:'hello\nBcc:x'},{text:'\x00'},{text:'ü'.repeat(8193)},{expiresAt:Date.now()+600000},{wallet:wallet.address.toUpperCase()}])('rejects malformed or oversized scope %j',patch=>{
    expect(validMailCommand({...command(),...patch},env.CHIRPY_MAIL_SERVICE_URL)).toBe(false);
  });
  it('requires verified and consented correspondent-specific bindings',()=>{
    const c=command();const b={wallet:c.wallet,email:c.to,version:c.id,revoked:false,verifiedAt:Date.now()-2000,consentedAt:Date.now()-1000,expiresAt:Date.now()+10000,evidenceId:'synthetic-consent'};
    expect(validMailBinding(b,c.wallet,c.to)).toBe(true);
    for(const patch of [{revoked:true},{consentedAt:0},{verifiedAt:0},{email:'other@example.com'},{version:''},{expiresAt:0},{evidenceId:''}]) expect(validMailBinding({...b,...patch},c.wallet,c.to)).toBe(false);
  });
  it('rejects invalid worker actions before storage and authenticates status reads',async()=>{
    for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    for(const body of [null,{},[],{action:'stats'},{action:'tick',extra:true},'status']) {
      const response=res();await worker({method:'POST',headers:{authorization:`Bearer ${env.CHIRPY_MAIL_WORKER_SECRET}`},body},response);expect(response.code).toBe(400);
    }
    const denied=res();await worker({method:'POST',headers:{},body:{action:'status'}},denied);expect(denied.code).toBe(401);expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue({ok:true,json:async()=>({result:[1000000,2,1,42,999999]})});
    const allowed=res();await worker({method:'POST',headers:{authorization:`Bearer ${env.CHIRPY_MAIL_WORKER_SECRET}`},body:{action:'status'}},allowed);
    expect(allowed.code).toBe(200);expect(allowed.body).toMatchObject({workerHealthy:true,queued:2,due:1});expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects unsupported suppression records before storage',async()=>{
    const kv=vi.fn();const config=mailConfig(env);
    for(const record of [null,{}, {email:'bad',reason:'opt-out',evidenceId:'e'}, {email:'a@example.com',reason:'other',evidenceId:'e'}, {email:'a@example.com',reason:'complaint',evidenceId:''}])await expect(suppressMailRecipient(config,record,kv)).rejects.toThrow();
    expect(kv).not.toHaveBeenCalled();
  });
  it('disabled handlers perform no storage or provider requests',async()=>{
    vi.stubEnv('CHIRPY_MAIL_ENABLED','');const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const a=res();await handler({method:'POST',body:{},headers:{}},a);expect(a.code).toBe(503);
    const b=res();await worker({method:'POST',headers:{}},b);expect(b.code).toBe(503);expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects cross-origin requests, forged signatures and missing worker secrets before touching storage',async()=>{
    for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const a=res();await handler({method:'POST',body:{},headers:{origin:'https://evil.example','content-type':'application/json'}},a);expect(a.code).toBe(403);
    const b=res();await handler({method:'POST',body:{command:command(),signature:'0x00'},headers:{'content-type':'application/json'}},b);expect(b.code).toBe(401);
    const d=res();await worker({method:'POST',headers:{authorization:'Bearer wrong'}},d);expect(d.code).toBe(401);expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('private forwarding receipt projection',()=>{
 const createdAt=1700000000000;
 const job=()=>({...command(),createdAt,updatedAt:createdAt+1000,deadline:createdAt+82800000,attempts:1,status:'accepted',providerId:'private-provider-id',lease:'private-lease',bindingKey:'private-binding',suppressionKey:'private-suppression',digest:'private-digest',identityScope:{private:'authority'}});
 it('returns only bounded receipt details from the wallet-specific key without reading payloads',async()=>{
  const c={...command(),action:'status'},config=mailConfig(env)!,kv=vi.fn(async()=>JSON.stringify(job()));
  const result=await createMailService(config,kv).execute(c);
  expect(result).toEqual({id:c.id,status:'accepted',receipt:{version:1,createdAt,updatedAt:createdAt+1000,attempts:1,retryUntil:createdAt+82800000}});
  expect(kv).toHaveBeenCalledExactlyOnceWith(['GET',`${config.prefix}job:${hash(`${c.wallet}\n${c.id}`)}`]);
  expect(JSON.stringify(result)).not.toMatch(/private|recipient|email|subject|lease|providerId/);
 });
 it('keeps unknown and legacy records honest without fabricating update times',async()=>{
  const config=mailConfig(env)!,c={...command(),action:'status'};
  expect(await createMailService(config,async()=>null).execute(c)).toEqual({status:'unknown',id:c.id});
  const old=job();delete old.updatedAt;
  expect((await createMailService(config,async()=>JSON.stringify(old)).execute(c)).receipt.updatedAt).toBeNull();
 });
 it.each([{wallet:'0x'+'f'.repeat(40)},{id:'cd'.repeat(16)},{status:'delivered'},{attempts:6},{updatedAt:0}])('rejects corrupt or mismatched job evidence %j',async patch=>{
  await expect(createMailService(mailConfig(env)!,async()=>JSON.stringify({...job(),...patch})).execute({...command(),action:'status'})).rejects.toThrow();
 });
});

describe('signed forwarding discovery scope',()=>{
 const query=()=>({action:'history',service:env.CHIRPY_MAIL_SERVICE_URL,wallet:wallet.address.toLowerCase(),id:'a'.repeat(32),expiresAt:Date.now()+60000,cursor:null});
 it('binds every history field and cannot reuse send or status authorization',async()=>{
  const c=query(),signature=await wallet.signMessage({message:mailSignMessage(c)});expect(await verifyMailCommand(c,signature,c.service)).toBe(true);
  for(const change of [{cursor:'b'.repeat(64)},{id:'b'.repeat(32)},{wallet:'0x'+'1'.repeat(40)},{service:'https://other.example/api/mail'},{expiresAt:c.expiresAt+1},{action:'status'},{action:'send',to:'a@example.com',subject:'x',text:'x'}])expect(await verifyMailCommand({...c,...change},signature,c.service)).toBe(false);
  const old={...command(),action:'status'};expect(await verifyMailCommand(c,await wallet.signMessage({message:mailSignMessage(old)}),c.service)).toBe(false);
 });
 it('authenticates discovery at the HTTP boundary before storage and advertises support',async()=>{
  for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const c=query();
  const info=res();await handler({method:'GET',headers:{}},info);expect(info.body.historyVersion).toBe(1);
  for(const patch of [{signature:'0x00'},{command:{...c,cursor:'bad'},signature:'0x00'}]){
   const denied=res();await handler({method:'POST',headers:{'content-type':'application/json'},body:{command:c,...patch}},denied);expect(denied.code).toBe(401);
  }
  expect(fetcher).not.toHaveBeenCalled();fetcher.mockResolvedValue({ok:true,json:async()=>({result:['history']})});
  const accepted=res();await handler({method:'POST',headers:{'content-type':'application/json'},body:{command:c,signature:await wallet.signMessage({message:mailSignMessage(c)})}},accepted);
  expect(accepted.code).toBe(200);expect(accepted.body).toMatchObject({status:'history',wallet:c.wallet,ids:[],nextCursor:null});expect(fetcher).toHaveBeenCalledOnce();
 });
 it.each([{cursor:''},{cursor:'b'.repeat(63)},{cursor:2},{to:'a@example.com'},{extra:true}])('rejects malformed discovery scope %j',patch=>{expect(validMailCommand({...query(),...patch},env.CHIRPY_MAIL_SERVICE_URL)).toBe(false);});
});
