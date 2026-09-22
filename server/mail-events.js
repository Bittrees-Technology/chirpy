import { Webhook } from 'svix';
import { mailConfig, mailKv, hash, suppressionKey } from './mail-service.js';
import { normalizeMailAddress } from '../packages/core/src/mailAuth.js';

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
export async function readMailEventBody(request) {
  const length=request.headers.get('content-length');
  if(length!==null && (!/^\d+$/.test(length) || Number(length)>65536)) throw Error('body limit');
  if(!request.body) throw Error('body required');
  const reader=request.body.getReader();const chunks=[];let size=0,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});},5000);
  try {
    for(;;) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>65536){void reader.cancel().catch(()=>{});throw Error('body limit');}
      chunks.push(Buffer.from(value));
    }
    if(timedOut)throw Error('body timeout');
    return Buffer.concat(chunks);
  } finally {clearTimeout(timer);reader.releaseLock();}
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
  if(!['email.bounced','email.complained'].includes(event?.type))return reply(200,{status:'ignored'});
  const data=event.data;
  // Chirpy sends one plain-address recipient per email. Ignore other applications.
  const from=normalizeMailAddress(data?.from);
  if(!from)return reply(400,{error:'Invalid event scope.'});
  if(from!==config.from)return reply(200,{status:'ignored'});
  const email=Array.isArray(data?.to) && data.to.length===1 ? normalizeMailAddress(data.to[0]):null;
  if(!email || normalizeMailAddress(data?.from)!==config.from || typeof data.email_id!=='string' || !data.email_id || data.email_id.length>200)return reply(400,{error:'Invalid event scope.'});
  const reason=event.type==='email.bounced'?'bounce':'complaint';
  const digest=hash(JSON.stringify([event.type,data.email_id,config.from,email.toLowerCase()]));
  const record=JSON.stringify({version:1,reason,evidenceHash:hash(headers['svix-id'])});
  try {
    const kv=storage||mailKv(config);
    const result=await kv(['EVAL',APPLY_MAIL_EVENT,'2',`${config.prefix}event:${hash(headers['svix-id'])}`,suppressionKey(config,email),digest,record]);
    if(result==='conflict')return reply(409,{error:'Event identity conflict.'});
    if(!['applied','duplicate'].includes(result))throw Error('storage result');
    return reply(200,{status:result});
  } catch {return reply(503,{error:'Mail event storage temporarily unavailable.'});}
}
