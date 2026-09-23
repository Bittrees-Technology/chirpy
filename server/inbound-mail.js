import {inboundHistoryOwner,inboundHistoryKey} from './inbound-history.js';
import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { normalizeMailAddress } from '../packages/core/src/mailAuth.js';
import { hash,mailKv } from './mail-service.js';
import { readMailEventBody } from './mail-events.js';
import { authenticateInboundMail,INBOUND_MAIL_SERVICE } from './inbound-mail-contract.js';
const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const statuses=['queued','sending','published','uncertain','stopped'];
export function inboundMailConfig(env=process.env){
  if(env.CHAT_MAIL_INBOUND_ENABLED!=='1'||(env.VERCEL_ENV&&env.VERCEL_ENV!=='production'))return null;
  try{
    const identity=new URL(env.CHAT_MAIL_INBOUND_IDENTITY_URL),kv=new URL(env.KV_REST_API_URL||env.UPSTASH_REDIS_REST_URL);
    const sourceSecret=env.CHAT_MAIL_INBOUND_SOURCE_SECRET,key=env.CHAT_MAIL_INBOUND_DATA_KEY,credential=env.CHAT_MAIL_INBOUND_IDENTITY_SECRET;
    const mailboxes=String(env.CHAT_MAIL_INBOUND_MAILBOXES||'').split(',').map(s=>s.trim());
    if(identity.protocol!=='https:'||identity.pathname!=='/api/service/inbound'||identity.username||identity.password||identity.search||identity.hash||kv.protocol!=='https:'||kv.username||kv.password||!mailboxes.length||mailboxes.length>20||mailboxes.some(m=>!m||normalizeMailAddress(m)!==m)||!/^([a-f0-9]{64})$/.test(sourceSecret||'')||!/^([a-f0-9]{64})$/.test(key||'')||sourceSecret===key||credential===key||credential===sourceSecret||typeof credential!=='string'||credential.length<32||credential.length>512||!/^[\x21-\x7e]+$/.test(credential)||!(env.KV_REST_API_TOKEN||env.UPSTASH_REDIS_REST_TOKEN))return null;
    return {sourceSecret,key:Buffer.from(key,'hex'),identity:{url:identity.href,credential},mailboxes,kvUrl:kv.href,kvToken:env.KV_REST_API_TOKEN||env.UPSTASH_REDIS_REST_TOKEN,prefix:`chat:mail-inbound:${hash(INBOUND_MAIL_SERVICE)}:`};
  }catch{return null;}
}
export const ENQUEUE_INBOUND_MAIL=`
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local old=redis.call('GET',KEYS[1]);if old then local j=cjson.decode(old);if j.digest~=ARGV[1] then return 'conflict' end;return j.status end
local deadline=math.min(tonumber(ARGV[4]),tonumber(ARGV[5]));if deadline<=now then return 'expired' end
if redis.call('ZCARD',KEYS[3])>=1000 or tonumber(redis.call('GET',KEYS[4]) or '0')>=200 or tonumber(redis.call('GET',KEYS[5]) or '0')>=1000 then return 'limited' end
local historyType=redis.call('TYPE',KEYS[6]).ok;if historyType~='none' and historyType~='zset' then return redis.error_reply('Invalid history index') end
local j=cjson.decode(ARGV[2]);j.status='queued';j.createdAt=now;j.updatedAt=now;j.deadline=deadline;j.attempts=0
redis.call('SET',KEYS[1],cjson.encode(j),'PX',2592000000)
redis.call('SET',KEYS[2],ARGV[3],'PX',deadline-now)
redis.call('ZADD',KEYS[3],now,KEYS[1])
redis.call('ZREMRANGEBYSCORE',KEYS[6],'-inf',now-2592000000)
redis.call('ZADD',KEYS[6],now,KEYS[1]);redis.call('ZREMRANGEBYRANK',KEYS[6],0,-32001);redis.call('PEXPIRE',KEYS[6],2592000000)
for i=4,5 do if redis.call('INCR',KEYS[i])==1 then redis.call('PEXPIRE',KEYS[i],86400000) end end
return 'queued'
`;
function encode(config,value,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',config.key,iv);cipher.setAAD(Buffer.from(aad));const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('base64')});}
export function decodeInboundMail(config,raw,aad){const e=JSON.parse(raw),cipher=createDecipheriv('aes-256-gcm',config.key,Buffer.from(e.iv,'hex'));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(Buffer.from(e.tag,'hex'));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(e.data,'base64')),cipher.final()]).toString('utf8'));}
export async function resolveInboundMail(config,scope,request=fetch){
  const response=await request(config.identity.url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.identity.credential}`,'Content-Type':'application/json'},body:JSON.stringify(scope),signal:AbortSignal.timeout(5000)});
  if(!response.ok){if([400,401,403,404,409,410].includes(response.status))return null;throw Error('Inbound authority unavailable');}
  const raw=await readMailEventBody(response,4096);if(raw.length>4096)throw Error('Inbound authority response too large');
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(!result||result.bindingId!==scope.bindingId||result.version!==scope.expectedVersion||result.mailbox!==scope.mailbox||result.deliveryId!==scope.deliveryId||result.contentHash!==scope.contentHash||!/^0x[a-f0-9]{40}$/.test(result.wallet||'')||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=Date.now()||result.expiresAt>Date.now()+23*3600000)return null;
  return {wallet:result.wallet,expiresAt:result.expiresAt};
}
export async function enqueueInboundMail(config,{event,scope},storage=mailKv(config),request=fetch){
  if(!config.mailboxes.includes(event.mailbox))return {status:'denied',id:event.id};
  const key=`${config.prefix}job:${scope.deliveryId}`;
  const prior=await storage(['GET',key]);
  if(prior){const j=JSON.parse(prior);if(j.digest!==scope.contentHash)return {status:'conflict',id:event.id};if(!statuses.includes(j.status))throw Error('Invalid stored status');return {status:j.status,id:event.id};}
  const recipient=await resolveInboundMail(config,scope,request);if(!recipient)return {status:'denied',id:event.id};
  const historyOwner=inboundHistoryOwner(config,recipient.wallet);
  const record={id:event.id,digest:scope.contentHash,identityService:config.identity.url,historyOwner};
  const encrypted=encode(config,{event,scope,recipient},key);
  const status=await storage(['EVAL',ENQUEUE_INBOUND_MAIL,'6',key,`${key}:payload`,`${config.prefix}queue`,`${config.prefix}quota:${hash(event.mailbox.toLowerCase())}`,`${config.prefix}quota:all`,inboundHistoryKey(config,historyOwner),scope.contentHash,JSON.stringify(record),encrypted,String(event.receivedAt+23*3600000),String(recipient.expiresAt)]);
  if(![...statuses,'conflict','expired','limited'].includes(status))throw Error('Invalid storage result');
  return {status,id:event.id};
}
export async function handleInboundMail(request,env=process.env,storage,identityRequest){
  if(request.method!=='POST')return reply(405,{error:'Use POST.'});
  const config=inboundMailConfig(env);if(!config)return reply(503,{enabled:false,error:'Inbound mail is not configured.'});
  if(request.url!==INBOUND_MAIL_SERVICE||request.headers.has('origin')||request.headers.has('cookie'))return reply(403,{error:'Server source required.'});
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply(415,{error:'Use JSON.'});
  if(!/^\d{13}$/.test(request.headers.get('x-chat-mail-timestamp')||'')||!/^[a-f0-9]{64}$/.test(request.headers.get('x-chat-mail-signature')||''))return reply(401,{error:'Source authorization required.'});
  let raw;try{raw=await readMailEventBody(request);}catch{return reply(400,{error:'Invalid event body.'});}
  const authorized=authenticateInboundMail(raw,request.headers.get('x-chat-mail-timestamp'),request.headers.get('x-chat-mail-signature'),config.sourceSecret);
  if(!authorized)return reply(401,{error:'Invalid source event authorization.'});
  try{
    const result=await enqueueInboundMail(config,authorized,storage,identityRequest);
    return reply(({denied:403,conflict:409,expired:410,limited:429,queued:202})[result.status]||200,result);
  }catch{return reply(503,{error:'Inbound queue unavailable. Retry the same event; do not create a new event ID.'});}
}
