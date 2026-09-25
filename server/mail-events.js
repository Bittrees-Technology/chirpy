import {mailDeliveryKey,APPLY_MAIL_DELIVERY_EVENT} from './mail-delivery.js';
import { Webhook } from 'svix';
import { mailConfig, mailKv, hash, suppressionKey } from './mail-service.js';
import { normalizeMailAddress, MAIL_DELIVERY_EVENTS } from '../packages/core/src/mailAuth.js';

export const APPLY_MAIL_EVENT = `
local old=redis.call('GET',KEYS[1])
if old then if old==ARGV[1] then return 'duplicate' else return 'conflict' end end
redis.call('SET',KEYS[2],ARGV[2],'NX')
redis.call('SET',KEYS[1],ARGV[1],'EX',2592000)
return 'applied'
`;
const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function mailEventConfig(env=process.env) {
  if(env.CHIRPY_MAIL_WEBHOOK_ENABLED!=='1') return null;
  const secret=env.RESEND_WEBHOOK_SECRET || '';
  if(!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.slice(6),'base64').length<24 || secret.length>200) return null;
  // Late complaints must still suppress recipients while outbound sending is paused.
  const config=mailConfig({...env,CHIRPY_MAIL_ENABLED:'1'},{deliveryIdentity:false});
  if(!config) return null;
  try {return {...config,webhook:new Webhook(secret)};} catch {return null;}
}
export async function readMailEventBody(request,limit=65536) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>65536)throw Error('body limit');
  const length=request.headers.get('content-length');
  if(length!==null && (!/^\d+$/.test(length) || Number(length)>limit)) throw Error('body limit');
  if(!request.body) throw Error('body required');
  const reader=request.body.getReader();const chunks=[];let size=0,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});},5000);
  try {
    for(;;) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit){void reader.cancel().catch(()=>{});throw Error('body limit');}
      chunks.push(Buffer.from(value));
    }
    if(timedOut)throw Error('body timeout');
    return Buffer.concat(chunks);
  } finally {clearTimeout(timer);reader.releaseLock();}
}
// Provider senders may include a display name; application addresses remain strict.
function providerSender(value) {
  const plain=normalizeMailAddress(value);
  if(plain)return plain;
  if(typeof value!=='string'||value.length>512||/[\x00-\x1f\x7f]/.test(value))return null;
  const named=value.match(/^(?:[^<>"\\,]+|"(?:[^"\\]|\\["\\])*") <([^<>]+)>$/);
  return named ? normalizeMailAddress(named[1]) : null;
}
export async function handleMailEvent(request,env=process.env,storage) {
  if(request.method!=='POST')return reply(405,{error:'Use POST.'});
  const config=mailEventConfig(env);if(!config)return reply(503,{error:'Mail events are not configured.'});
  const headers=Object.fromEntries(['svix-id','svix-timestamp','svix-signature'].map(key=>[key,request.headers.get(key)||'']));
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(headers['svix-id']) || !/^\d{1,16}$/.test(headers['svix-timestamp']) || !headers['svix-signature'] || headers['svix-signature'].length>2048)return reply(401,{error:'Invalid event authorization.'});
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply(415,{error:'Use JSON.'});
  let raw;
  try {raw=await readMailEventBody(request);} catch {return reply(400,{error:'Invalid event body.'});}
  try {config.webhook.verify(raw,headers);} catch {return reply(401,{error:'Invalid event authorization.'});}
  let event;
  try {event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));} catch {return reply(400,{error:'Invalid event body.'});}
  if(typeof event?.type!=='string'||!event.type.startsWith('email.')||!MAIL_DELIVERY_EVENTS.includes(event.type.slice(6)))return reply(200,{status:'ignored'});
  const data=event.data;
  // Chat sends one plain-address recipient per email. Ignore other applications.
  const from=providerSender(data?.from);
  if(!from)return reply(400,{error:'Invalid event scope.'});
  if(from!==config.from)return reply(200,{status:'ignored'});
  const email=Array.isArray(data?.to) && data.to.length===1 ? normalizeMailAddress(data.to[0]):null;
  if(!email || typeof data.email_id!=='string' || !data.email_id || data.email_id.length>200)return reply(400,{error:'Invalid event scope.'});
  const reason=event.type==='email.bounced'?'bounce':event.type==='email.complained'?'complaint':null;
  const at=typeof event.created_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(event.created_at)?Date.parse(event.created_at):NaN;
  const timed=Number.isSafeInteger(at)&&at>0&&at<=Date.now()+300000;
  // Preserve existing bounce/complaint suppression even when a legacy event has no usable timestamp.
  if(!timed&&!reason)return reply(400,{error:'Invalid event time.'});
  const digest=hash(JSON.stringify([event.type,data.email_id,config.from,email.toLowerCase()]));
  const record=JSON.stringify({version:1,reason,evidenceHash:hash(headers['svix-id'])});
  try {
    const kv=storage||mailKv(config);
    const legacyKey=`${config.prefix}event:${hash(headers['svix-id'])}`,recipientKey=suppressionKey(config,email);
    const result=await kv(['EVAL',APPLY_MAIL_DELIVERY_EVENT,'4',`${config.prefix}delivery-event:${hash(headers['svix-id'])}`,mailDeliveryKey(config,data.email_id,recipientKey),legacyKey,recipientKey,hash(JSON.stringify([digest,timed?at:null])),digest,reason?record:'',event.type.slice(6),String(timed?at:0)]);
    if(result==='invalid')return reply(503,{error:'Mail event evidence unavailable.'});
    if(result==='conflict')return reply(409,{error:'Event identity conflict.'});
    if(!['applied','duplicate'].includes(result))throw Error('storage result');
    return reply(200,{status:result});
  } catch {return reply(503,{error:'Mail event storage temporarily unavailable.'});}
}
