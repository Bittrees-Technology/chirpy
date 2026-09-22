import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {createPublicClient,http,recoverMessageAddress} from 'viem';
import {mainnet} from 'viem/chains';
import {createSiweMessage} from 'viem/siwe';
export const CHAT_ORIGIN='https://chat.bittrees.org';
export const MAIL_ORIGIN='https://mail.bittrees.org';
const address=v=>typeof v==='string'&&/^0x[a-f0-9]{40}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const hash=v=>createHash('sha256').update(v).digest('hex');
const random=()=>randomBytes(32).toString('hex');
export class ConnectedMailError extends Error{constructor(status,message){super(message);this.status=status;}}
const denied=()=>new ConnectedMailError(401,'Reconnect your mailbox from Chat.');
export function exactMailInput(input,keys){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))throw new ConnectedMailError(400,'Invalid mail request.');}
export function connectedMailConfig(env=process.env,{allowDisabled=false}={}){
 if((env.CHAT_CONNECTED_MAIL_ENABLED!=='1'&&!allowDisabled)||(env.VERCEL_ENV&&env.VERCEL_ENV!=='production'))return null;
 try{
  const url=new URL(env.KV_REST_API_URL||env.UPSTASH_REDIS_REST_URL),key=env.CHAT_CONNECTED_MAIL_KEY,kvToken=env.KV_REST_API_TOKEN||env.UPSTASH_REDIS_REST_TOKEN;
  const testWallets=String(env.CHAT_CONNECTED_MAIL_TEST_WALLETS||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
  if(testWallets.some(v=>!address(v)))return null;
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!hex(key)||!kvToken)return null;
  return {kvUrl:url.href,kvToken,key:Buffer.from(key,'hex'),prefix:'chat:connected-mail:v1:',testWallets,rpc:env.MAINNET_RPC_URL||''};
 }catch{return null;}
}
export const CONNECTION_CAS=`
local raw=redis.call('GET',KEYS[1])
local clock=redis.call('TIME');local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local expiry=tonumber(ARGV[3])
if not raw or raw~=ARGV[1] or not expiry then return 0 end
if expiry==0 then redis.call('SET',KEYS[1],ARGV[2]);return 1 end
local ttl=expiry-now
if ttl<=0 then return 0 end
redis.call('SET',KEYS[1],ARGV[2],'PX',ttl);return 1
`;
const liveGrant=(g,now)=>g&&(g.expiresAt===null||typeof g.expiresAt==='string'&&Number.isFinite(Date.parse(g.expiresAt))&&Date.parse(g.expiresAt)>now);
export function connectionCookieAge(connection,now=Date.now()){return connection.expiresAt===null?400*86400:Math.max(0,Math.ceil((Date.parse(connection.expiresAt)-now)/1000));}
export const CONNECTION_RATE=`
local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('PEXPIRE',KEYS[1],600000) end;return n
`;
export function connectionKv(config,request=fetch){return async command=>{
 const response=await request(config.kvUrl,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+config.kvToken,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new ConnectedMailError(503,'Mail connection storage is unavailable.');
 const result=await response.json();if(result.error)throw new ConnectedMailError(503,'Mail connection storage is unavailable.');return result.result;
};}
function encrypt(config,value,aad){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',config.key,iv);c.setAAD(Buffer.from(aad));const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return JSON.stringify({iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),data:data.toString('base64')});}
function decrypt(config,raw,aad){try{const e=JSON.parse(raw),c=createDecipheriv('aes-256-gcm',config.key,Buffer.from(e.iv,'hex'));c.setAAD(Buffer.from(aad));c.setAuthTag(Buffer.from(e.tag,'hex'));return JSON.parse(Buffer.concat([c.update(Buffer.from(e.data,'base64')),c.final()]).toString());}catch{throw denied();}}
async function verifyWallet(config,wallet,message,signature){
 if(typeof signature!=='string'||!/^0x[a-fA-F0-9]{2,8192}$/.test(signature))return false;
 try{if((await recoverMessageAddress({message,signature})).toLowerCase()===wallet)return true;}catch{}
 if(!config.rpc)return false;
 try{const url=new URL(config.rpc);if(url.protocol!=='https:')return false;return await createPublicClient({chain:mainnet,transport:http(config.rpc,{timeout:8000,retryCount:0})}).verifyMessage({address:wallet,message,signature});}catch{return false;}
}
export function createConnectedMail(config,{kv=connectionKv(config),request=fetch,verify=(wallet,message,signature)=>verifyWallet(config,wallet,message,signature),now=()=>Date.now()}={}){
 const allowed=wallet=>!config.testWallets?.length||config.testWallets.includes(wallet);
 const key=(kind,token)=>config.prefix+kind+':'+hash(token);
 async function put(kind,token,value,ttl){const k=key(kind,token);if(await kv(['SET',k,encrypt(config,value,k),'PX',String(ttl),'NX'])!=='OK')throw new ConnectedMailError(503,'Start a new connection.');}
 async function session(token,wallet){if(!hex(token))throw denied();const k=key('session',token),raw=await kv(['GET',k]);if(!raw)throw denied();const value=decrypt(config,raw,k);if(!address(value.wallet)||!allowed(value.wallet)||!(value.expires===null&&value.connection?.expiresAt===null||Number.isFinite(value.expires)&&value.expires>now())||(wallet!==undefined&&value.wallet!==wallet))throw denied();return {k,raw,value};}
 async function cas(record,value){if(Number(await kv(['EVAL',CONNECTION_CAS,'1',record.k,record.raw,encrypt(config,value,record.k),String(value.expires===null?0:value.expires)]))!==1)throw new ConnectedMailError(409,'Mail connection changed. Refresh Chat.');}
 async function mail(action,input,token){
  const response=await request(MAIL_ORIGIN+'/api/integrations/chat/'+action,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','User-Agent':'Chat-Mail-Relay/1.0',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(input),signal:AbortSignal.timeout(25000)});
  const reader=response.body?.getReader();if(!reader)throw new ConnectedMailError(502,'Mail returned an invalid response.');let size=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2000000){await reader.cancel();throw new ConnectedMailError(502,'Mail response is too large.');}chunks.push(value);}
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new ConnectedMailError(502,'Mail connection is unavailable.');}
  if(!response.ok)throw new ConnectedMailError([400,401,403,404,409,413,429].includes(response.status)?response.status:503,'Mail could not complete the request. If sending, check Sent before retrying.');
  return result;
 }
 async function revokeGrant(token){try{await mail('disconnect',{},token);return true;}catch{return false;}}
 const publicConnection=g=>g?{mailbox:g.mailbox,scopes:g.scopes,expiresAt:g.expiresAt}:null;
 return {
  async challenge(wallet){
   if(!address(wallet))throw new ConnectedMailError(400,'Choose a valid wallet.');
   if(!allowed(wallet))throw new ConnectedMailError(403,'Connected Mail is available to test accounts only.');
   if(Number(await kv(['EVAL',CONNECTION_RATE,'1',config.prefix+'rate:'+hash(wallet)]))>10)throw new ConnectedMailError(429,'Wait before starting another Mail connection.');
   const token=random(),expires=now()+300000;
   const message=createSiweMessage({address:wallet,domain:'chat.bittrees.org',uri:CHAT_ORIGIN+'/api/mail/verify',version:'1',chainId:1,nonce:random(),issuedAt:new Date(now()),expirationTime:new Date(expires),statement:'Sign in to connect your mailbox to Chat. Mail will separately ask for read and send permission. No transaction is authorized.'});
   await put('challenge',token,{wallet,message,expires},300000);return {token,message};
  },
  async verify(token,input){
   exactMailInput(input,['wallet','message','signature']);if(!hex(token)||!address(input.wallet)||!allowed(input.wallet))throw denied();
   const k=key('challenge',token),raw=await kv(['GETDEL',k]);if(!raw)throw denied();const challenge=decrypt(config,raw,k);
   if(challenge.expires<=now()||challenge.wallet!==input.wallet||challenge.message!==input.message||!await verify(input.wallet,challenge.message,input.signature)||challenge.expires<=now())throw denied();
   const sessionToken=random(),value={wallet:input.wallet,expires:now()+3600000,connection:null,pending:null};
   await put('session',sessionToken,value,3600000);return {token:sessionToken,wallet:value.wallet,expiresAt:value.expires};
  },
  async status(token,wallet){const {value}=await session(token,wallet);return {wallet:value.wallet,connection:publicConnection(liveGrant(value.connection,now())?value.connection:null)};},
  async start(token,wallet){
   const record=await session(token,wallet);
   // An expired grant is already unusable at Mail and hidden by status. Replace it
   // atomically with fresh consent state; never replace a live or malformed grant.
   if(record.value.connection&&(record.value.connection.expiresAt===null||!(Date.parse(record.value.connection.expiresAt)<=now())))throw new ConnectedMailError(409,'Disconnect your current mailbox before connecting another.');
   const verifier=randomBytes(32).toString('base64url'),state=random(),challenge=createHash('sha256').update(verifier).digest('base64url');
   const value={...record.value,connection:null,pending:{state,verifier,expires:now()+300000}};await cas(record,value);
   const url=new URL('/connect/chat',MAIL_ORIGIN);url.hash=new URLSearchParams({challenge,state,wallet:value.wallet}).toString();return {url:url.href};
  },
  async callback(token,input){
   exactMailInput(input,['wallet','state','code']);if(!address(input.wallet)||!hex(input.state)||!hex(input.code))throw denied();
   const record=await session(token,input.wallet),pending=record.value.pending;
   if(!pending||pending.state!==input.state||pending.expires<=now()||record.value.connection)throw denied();
   const consumed={...record.value,pending:null};await cas(record,consumed);
   // Consume before exchange. A failed/uncertain exchange must start a fresh connection.
   const after=await session(token,input.wallet);if(after.value.pending||after.value.connection)throw denied();
   const grant=await mail('exchange',{code:input.code,verifier:pending.verifier,wallet:input.wallet,audience:CHAT_ORIGIN});
   const expiry=grant?.expiresAt===null?null:typeof grant?.expiresAt==='string'?Date.parse(grant.expiresAt):NaN;
   if(!hex(grant?.token)||Object.keys(grant).some(k=>!['token','grantId','wallet','mailbox','scopes','audience','expiresAt'].includes(k))||!hex(grant?.grantId)||grant.wallet!==input.wallet||grant.audience!==CHAT_ORIGIN||typeof grant.mailbox!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}@bittrees\.org$/.test(grant.mailbox)||!Array.isArray(grant.scopes)||!grant.scopes.length||grant.scopes.length>2||new Set(grant.scopes).size!==grant.scopes.length||grant.scopes.some(s=>!['read','send'].includes(s))||expiry!==null&&(!Number.isFinite(expiry)||expiry<=now()||expiry>now()+30*86400000)){if(hex(grant?.token))await revokeGrant(grant.token);throw new ConnectedMailError(502,'Mail returned an invalid connection.');}
   try{if(pending.expires<=now())throw denied();await cas(after,{...after.value,expires:expiry===null?null:Math.max(after.value.expires,expiry),connection:grant});}catch(e){await revokeGrant(grant.token);throw e;}
   return publicConnection(grant);
  },
  async operation(token,input){
   exactMailInput(input,['wallet','action','input']);const record=await session(token,input.wallet),grant=record.value.connection;
   if(!address(input.wallet)||!liveGrant(grant,now()))throw denied();
   const scope=input.action==='send'?'send':['folders','messages','message','threads','thread','attachments','attachment','html'].includes(input.action)?'read':null;
   if(!scope||!grant.scopes.includes(scope))throw new ConnectedMailError(403,'This connection does not allow that action.');
   const result=await mail('operation',input,grant.token);
   const latest=await session(token,input.wallet);if(latest.value.connection?.grantId!==grant.grantId||!liveGrant(grant,now()))throw denied();
   return result;
  },
  async disconnect(token){
   if(!hex(token))throw denied();const k=key('session',token),raw=await kv(['GETDEL',k]);if(!raw)return {ok:true,sourceRevoked:true};
   const value=decrypt(config,raw,k);return {ok:true,sourceRevoked:value.connection?await revokeGrant(value.connection.token):true};
  }
 };
}
