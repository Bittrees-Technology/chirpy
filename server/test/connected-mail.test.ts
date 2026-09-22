import {describe,it,expect,vi} from 'vitest';
import {privateKeyToAccount} from 'viem/accounts';
import {connectedMailConfig,createConnectedMail,CONNECTION_CAS,CONNECTION_RATE,CHAT_ORIGIN} from '../connected-mail.js';
import {createConnectedMailHandler} from '../connected-mail-http.js';
const signer=privateKeyToAccount(`0x${'1'.repeat(64)}`),wallet=signer.address.toLowerCase();
function fixture(){
 const config=connectedMailConfig({CHAT_CONNECTED_MAIL_ENABLED:'1',CHAT_CONNECTED_MAIL_KEY:'ab'.repeat(32),KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'fixture'});
 const records=new Map<string,string>(),calls:any[]=[];let clock=Date.now(),onRequest=async()=>{},response:any;
 const kv=vi.fn(async(args:any[])=>{
  const [cmd,k,v]=args;if(cmd==='GET')return records.get(k)??null;if(cmd==='GETDEL'){const raw=records.get(k)??null;records.delete(k);return raw;}
  if(cmd==='SET'){if(args.includes('NX')&&records.has(k))return null;records.set(k,v);return 'OK';}
  if(cmd==='EVAL'&&k===CONNECTION_RATE){const n=Number(records.get(args[3])||0)+1;records.set(args[3],String(n));return n;}
  if(cmd==='EVAL'&&k===CONNECTION_CAS){if(records.get(args[3])!==args[4]||Number(args[6])<=clock)return 0;records.set(args[3],args[5]);return 1;}
  throw Error('Unexpected command');
 });
 const grant={token:'a'.repeat(64),grantId:'b'.repeat(64),wallet,mailbox:'fixture@bittrees.org',scopes:['read','send'],audience:CHAT_ORIGIN,expiresAt:new Date(clock+1800000).toISOString()};
 const request=vi.fn(async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});await onRequest();if(response)return response();return Response.json(String(url).endsWith('/exchange')?grant:String(url).endsWith('/disconnect')?{ok:true}:{messages:[{text:'private fixture'}]});});
 const api=createConnectedMail(config,{kv,request,now:()=>clock});
 async function login(){const challenge=await api.challenge(wallet);const signature=await signer.signMessage({message:challenge.message});return api.verify(challenge.token,{wallet,message:challenge.message,signature});}
 async function pending(){const session=await login(),started=await api.start(session.token,wallet);const state=new URLSearchParams(new URL(started.url).hash.slice(1)).get('state');return {session,input:{wallet,state,code:'c'.repeat(64)},url:started.url};}
 async function connected(){const f=await pending();await api.callback(f.session.token,f.input);return f;}
 return {api,config,records,calls,kv,grant,login,pending,connected,onRequest(fn){onRequest=fn;},response(fn){response=fn;},advance(ms){clock+=ms;}};
}
describe('Connected Mail session and relay',()=>{
 it('is disabled unless explicitly configured and never enabled in previews',()=>{
  expect(connectedMailConfig({})).toBeNull();const f=fixture();expect(f.config).not.toBeNull();expect(connectedMailConfig({CHAT_CONNECTED_MAIL_KEY:'ab'.repeat(32),KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'fixture'},{allowDisabled:true})).not.toBeNull();
  for(const override of [{VERCEL_ENV:'preview'},{CHAT_CONNECTED_MAIL_KEY:'short'},{KV_REST_API_URL:'http://kv.test'}])expect(connectedMailConfig({CHAT_CONNECTED_MAIL_ENABLED:'1',CHAT_CONNECTED_MAIL_KEY:'ab'.repeat(32),KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'fixture',...override})).toBeNull();
 });
 it('requires exact one-use signed challenge, cookie possession and fresh signature',async()=>{
  const f=fixture(),challenge=await f.api.challenge(wallet),signature=await signer.signMessage({message:challenge.message});
  await expect(f.api.verify('d'.repeat(64),{wallet,message:challenge.message,signature})).rejects.toMatchObject({status:401});
  const verified=await f.api.verify(challenge.token,{wallet,message:challenge.message,signature});expect(verified.wallet).toBe(wallet);
  await expect(f.api.verify(challenge.token,{wallet,message:challenge.message,signature})).rejects.toMatchObject({status:401});
  const old=await f.api.challenge(wallet);f.advance(300001);await expect(f.api.verify(old.token,{wallet,message:old.message,signature:await signer.signMessage({message:old.message})})).rejects.toMatchObject({status:401});
  const bad=await f.api.challenge(wallet);await expect(f.api.verify(bad.token,{wallet,message:bad.message,signature:'0x'+'0'.repeat(130)})).rejects.toMatchObject({status:401});
 });
 it('bounds challenge creation in shared storage',async()=>{const f=fixture();for(let i=0;i<10;i++)await f.api.challenge(wallet);await expect(f.api.challenge(wallet)).rejects.toMatchObject({status:429});});
 it('binds callback to wallet/session/state and hides source credentials from browser results/storage',async()=>{
  const f=fixture(),p=await f.pending();expect(p.url.startsWith('https://mail.bittrees.org/connect/chat#')).toBe(true);
  const other=await f.login();await expect(f.api.callback(other.token,p.input)).rejects.toMatchObject({status:401});
  await expect(f.api.callback(p.session.token,{...p.input,wallet:'0x'+'2'.repeat(40)})).rejects.toMatchObject({status:401});
  await expect(f.api.callback(p.session.token,{...p.input,state:'e'.repeat(64)})).rejects.toMatchObject({status:401});
  const result=await f.api.callback(p.session.token,p.input);expect(result).toEqual({mailbox:f.grant.mailbox,scopes:['read','send'],expiresAt:f.grant.expiresAt});
  expect(JSON.stringify(await f.api.status(p.session.token,wallet))).not.toContain(f.grant.token);
  const stored=JSON.stringify([...f.records]);for(const secret of [f.grant.token,p.input.code,p.session.token,f.grant.mailbox])expect(stored).not.toContain(secret);
  const exchange=f.calls[0];expect(exchange.url).toBe('https://mail.bittrees.org/api/integrations/chat/exchange');expect(exchange.init.headers.Origin).toBeUndefined();expect(exchange.init.headers.Cookie).toBeUndefined();expect(exchange.init.redirect).toBe('error');
  await expect(f.api.callback(p.session.token,p.input)).rejects.toMatchObject({status:401});
 });
 it('only one simultaneous callback exchanges a code',async()=>{
  const f=fixture(),p=await f.pending();const results=await Promise.allSettled([f.api.callback(p.session.token,p.input),f.api.callback(p.session.token,p.input)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.calls.filter(c=>c.url.endsWith('/exchange'))).toHaveLength(1);
 });
 it('consumes uncertain exchanges without replay and rejects invalid grants',async()=>{
  for(const changed of [{unexpectedContent:'must not persist'},{wallet:'0x'+'2'.repeat(40)},{scopes:['admin']},{audience:'https://evil.test'},{expiresAt:'invalid'},{mailbox:'other@example.com'}]){
   const f=fixture(),p=await f.pending();Object.assign(f.grant,changed);await expect(f.api.callback(p.session.token,p.input)).rejects.toMatchObject({status:502});expect(f.calls.at(-1).url).toMatch(/disconnect$/);
   await expect(f.api.callback(p.session.token,p.input)).rejects.toMatchObject({status:401});
  }
  const f=fixture(),p=await f.pending();f.response(()=>{throw Error('network timeout');});await expect(f.api.callback(p.session.token,p.input)).rejects.toThrow();await expect(f.api.callback(p.session.token,p.input)).rejects.toMatchObject({status:401});
 });
 it('disconnect during exchange prevents late grant installation and revokes source access',async()=>{
  const f=fixture(),p=await f.pending();let once=true;f.onRequest(async()=>{if(once){once=false;await f.api.disconnect(p.session.token);}});
  await expect(f.api.callback(p.session.token,p.input)).rejects.toMatchObject({status:409});expect(f.calls.at(-1).url).toMatch(/disconnect$/);
  await expect(f.api.status(p.session.token,wallet)).rejects.toMatchObject({status:401});
 });
 it('enforces expiry and preserves wallet, operation and idempotency binding',async()=>{
  const f=fixture(),p=await f.connected(),input={wallet,action:'send',input:{to:f.grant.mailbox,subject:'Test',text:'Body',idempotencyKey:'fixture-request-01'}};
  await f.api.operation(p.session.token,input);expect(f.calls.at(-1).body).toEqual(input);expect(f.calls.at(-1).init.headers.Authorization).toBe('Bearer '+f.grant.token);
  await expect(f.api.operation(p.session.token,{...input,wallet:'0x'+'2'.repeat(40)})).rejects.toMatchObject({status:401});
  f.advance(1800001);await expect(f.api.operation(p.session.token,input)).rejects.toMatchObject({status:401});
 });
 it('read-only grants cannot send and late responses after disconnect are discarded',async()=>{
  const f=fixture();f.grant.scopes=['read'];const p=await f.connected();await expect(f.api.operation(p.session.token,{wallet,action:'send',input:{}})).rejects.toMatchObject({status:403});
  let once=true;f.onRequest(async()=>{if(once){once=false;await f.api.disconnect(p.session.token);}});
  await expect(f.api.operation(p.session.token,{wallet,action:'messages',input:{folder:'INBOX'}})).rejects.toMatchObject({status:401});
 });
 it('fails closed on oversized source responses and disconnect reports failed source revocation',async()=>{
  const f=fixture(),p=await f.connected();f.response(()=>new Response('x'.repeat(2000001)));await expect(f.api.operation(p.session.token,{wallet,action:'folders',input:{}})).rejects.toMatchObject({status:502});
  f.response(()=>new Response('{}',{status:503}));expect(await f.api.disconnect(p.session.token)).toEqual({ok:true,sourceRevoked:false});await expect(f.api.status(p.session.token,wallet)).rejects.toMatchObject({status:401});
 });
});
function httpFixture(f){const handler=createConnectedMailHandler({config:()=>f.config,service:()=>f.api,rate:()=>({allowed:true})});return async(action,body={},headers={},method=action==='status'?'GET':'POST',query={})=>{
 const res:any={headers:{},code:200,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(body){this.body=body;return this;},end(){return this;}};
 await handler({method,query:{action,...query},headers:{host:'chat.bittrees.org',origin:CHAT_ORIGIN,'content-type':'application/json',...headers},body},res);return res;
};}
describe('Connected Mail browser HTTP boundary',()=>{
 it('requires canonical host, exact Origin, supported methods and JSON',async()=>{
  const f=fixture(),call=httpFixture(f);
  for(const [headers,status]of [[{host:'chirpy.bittrees.org'},403],[{origin:'https://evil.test'},403],[{origin:undefined},403],[{authorization:'Bearer injected'},400],[{'content-type':'text/plain'},415]] as any)expect((await call('challenge',{wallet},headers)).code).toBe(status);
  expect((await call('challenge',{wallet},{},'GET')).code).toBe(405);expect((await call('challenge',{wallet,extra:'x'})).code).toBe(400);
  expect((await call('operation',{padding:'x'.repeat(65537)})).code).toBe(413);
 });
 it('uses HttpOnly secure host cookies and returns no raw session tokens',async()=>{
  const f=fixture(),call=httpFixture(f),challenge=await call('challenge',{wallet});expect(challenge.headers['Set-Cookie']).toContain('HttpOnly; Secure; SameSite=Strict');
  const cookie=challenge.headers['Set-Cookie'].split(';')[0],message=challenge.body.message;
  const result=await call('verify',{wallet,message,signature:await signer.signMessage({message})},{cookie});expect(result.code).toBe(200);expect(result.body.token).toBeUndefined();expect(result.headers['Cache-Control']).toBe('private, no-store');expect(result.headers['Set-Cookie'][1]).toContain('__Host-chat_mail_session=');
 });
 it('callback requires Mail Origin, one-use form fields and bound cookie, then redirects without secrets',async()=>{
  const f=fixture(),p=await f.pending(),call=httpFixture(f),cookie='__Host-chat_mail_session='+p.session.token,form=new URLSearchParams(p.input as any).toString();
  expect((await call('callback',form,{cookie,'content-type':'application/x-www-form-urlencoded'})).code).toBe(403);
  const headers={cookie,origin:'https://mail.bittrees.org','content-type':'application/x-www-form-urlencoded'};
  expect((await call('callback',form+'&state=duplicate',headers)).code).toBe(400);
  expect((await call('callback',form,{...headers,cookie:cookie+'; '+cookie})).code).toBe(401);
  const response=await call('callback',form,headers);expect(response.code).toBe(303);expect(response.headers.Location).toBe('https://chat.bittrees.org/?mail=connected');expect(JSON.stringify(response)).not.toContain(f.grant.token);
 });
});

it('HTTP disconnect can clear access while disabled; failures never expose upstream secrets',async()=>{
 const f=fixture(),p=await f.connected();const config=vi.fn(()=>f.config);const handler=createConnectedMailHandler({config,service:()=>f.api,rate:()=>({allowed:true})});
 const res:any={headers:{},code:0,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
 f.response(()=>{throw Error('private-token-and-body');});
 await handler({method:'POST',query:{action:'disconnect'},headers:{host:'chat.bittrees.org',origin:CHAT_ORIGIN,'content-type':'application/json',cookie:'__Host-chat_mail_session='+p.session.token},body:{}},res);
 expect(config).toHaveBeenCalledWith('disconnect');expect(res.code).toBe(200);expect(res.body.sourceRevoked).toBe(false);expect(res.headers['Set-Cookie']).toContain('Max-Age=0');expect(JSON.stringify(res)).not.toContain('private-token');
});

 it('acceptance allowlist gates challenges, verification and existing sessions without preventing disconnect',async()=>{
 const f=fixture(),p=await f.connected(),challenge=await f.api.challenge(wallet);f.config.testWallets=['0x'+'9'.repeat(40)];
 await expect(f.api.challenge(wallet)).rejects.toMatchObject({status:403});
 await expect(f.api.verify(challenge.token,{wallet,message:challenge.message,signature:await signer.signMessage({message:challenge.message})})).rejects.toMatchObject({status:401});
 await expect(f.api.status(p.session.token,wallet)).rejects.toMatchObject({status:401});
 await expect(f.api.operation(p.session.token,{wallet,action:'folders',input:{}})).rejects.toMatchObject({status:401});
 expect(await f.api.disconnect(p.session.token)).toEqual({ok:true,sourceRevoked:true});
});
it('HTTP disconnect clears an absent or malformed session for a fresh connection',async()=>{
 const call=httpFixture(fixture());
 for(const cookie of ['', '__Host-chat_mail_session=expired']){
  const response=await call('disconnect',{}, {cookie});
  expect(response.code).toBe(200);expect(response.body).toEqual({ok:true,sourceRevoked:true});
  expect(response.headers['Set-Cookie']).toContain('Max-Age=0');
 }
});

it('reconnects after status hides an expired grant without replacing active access',async()=>{
 const f=fixture(),p=await f.connected();
 await expect(f.api.start(p.session.token,wallet)).rejects.toMatchObject({status:409});
 f.advance(1800000);
 expect((await f.api.status(p.session.token,wallet)).connection).toBeNull();
 const started=await f.api.start(p.session.token,wallet);
 const state=new URLSearchParams(new URL(started.url).hash.slice(1)).get('state');
 expect(state).not.toBe(p.input.state);
 await expect(f.api.callback(p.session.token,p.input)).rejects.toMatchObject({status:401});
 f.grant.expiresAt=new Date(Date.parse(f.grant.expiresAt)+60000).toISOString();
 expect(await f.api.callback(p.session.token,{...p.input,state})).toMatchObject({mailbox:f.grant.mailbox});
 await expect(f.api.start(p.session.token,wallet)).rejects.toMatchObject({status:409});
});
it('expired-grant recovery discards an in-flight old response and never extends session lifetime',async()=>{
 const f=fixture(),p=await f.connected();
 f.onRequest(async()=>{f.advance(1800000);await f.api.start(p.session.token,wallet);});
 await expect(f.api.operation(p.session.token,{wallet,action:'messages',input:{folder:'INBOX'}})).rejects.toMatchObject({status:401});
 f.advance(1800000);
 await expect(f.api.start(p.session.token,wallet)).rejects.toMatchObject({status:401});
});
