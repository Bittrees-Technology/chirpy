import { mailIdentityConfig, mailIdentityScope, resolveMailIdentity } from './mail-identity.js';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import { normalizeMailAddress, mailSignMessage } from '../packages/core/src/mailAuth.js';
import { ENQUEUE_MAIL, CLAIM_MAIL, FINISH_MAIL, MAIL_WORKER_STATUS, MAIL_WORKER_HEARTBEAT, APPLY_MAIL_OPTOUT } from './mail-store.js';
export const hash = value => createHash('sha256').update(value).digest('hex');
const address = value => typeof value === 'string' && /^0x[a-f0-9]{40}$/.test(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function mailConfig(env = process.env, { deliveryIdentity = true } = {}) {
  if (env.CHIRPY_MAIL_ENABLED !== '1' || (env.VERCEL_ENV && env.VERCEL_ENV !== 'production')) return null;
  try {
    const service = new URL(env.CHIRPY_MAIL_SERVICE_URL);
    const kvUrl = new URL(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL);
    const from = normalizeMailAddress(env.CHIRPY_MAIL_FROM);
    const senders = String(env.CHIRPY_MAIL_SENDERS || '').split(',').map(v => v.trim().toLowerCase());
    if (service.protocol !== 'https:' || service.pathname !== '/api/mail' || service.search || service.hash || service.username || service.password || kvUrl.protocol !== 'https:' || kvUrl.username || kvUrl.password || !from || !senders.length || !senders.every(address) || !/^[a-f0-9]{64}$/.test(env.CHIRPY_MAIL_DATA_KEY || '') || (env.CHIRPY_MAIL_WORKER_SECRET || '').length < 32 || !env.RESEND_API_KEY || !(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN)) return null;
    return { identity: deliveryIdentity ? mailIdentityConfig(env) : null, service: service.href, kvUrl: kvUrl.href, kvToken: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN, from, senders, key: Buffer.from(env.CHIRPY_MAIL_DATA_KEY, 'hex'), providerKey: env.RESEND_API_KEY, workerSecret: env.CHIRPY_MAIL_WORKER_SECRET, prefix: `chirpy:mail:${hash(service.href)}:` };
  } catch { return null; }
}
export function mailKv(config, request = fetch) {
  return async command => {
    const response = await request(config.kvUrl, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${config.kvToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('storage unavailable');
    const result = await response.json(); if (result.error) throw Error('storage unavailable'); return result.result;
  };
}
export function validMailCommand(c, service, now = Date.now()) {
  if (!c || !['send','status'].includes(c.action) || c.service !== service || !address(c.wallet) || !id(c.id) || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= now || c.expiresAt > now+300000) return false;
  if (c.action === 'status') return true;
  return normalizeMailAddress(c.to) === c.to && typeof c.subject === 'string' && c.subject.trim().length > 0 && c.subject.length <= 120 && !/[\x00-\x1f\x7f]/.test(c.subject) && typeof c.text === 'string' && c.text.trim().length > 0 && Buffer.byteLength(c.text) <= 16384 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c.text);
}
export async function verifyMailCommand(c, signature, service, now) {
  if (!validMailCommand(c, service, now) || typeof signature !== 'string' || !/^0x[a-fA-F0-9]{130}$/.test(signature)) return false;
  try { return (await recoverMessageAddress({ message: mailSignMessage(c), signature })).toLowerCase() === c.wallet; } catch { return false; }
}
export const bindingKey = (config, wallet, email) => `${config.prefix}binding:${hash(`${wallet}\n${email}`)}`;
// Fold case conservatively for suppression so spelling changes cannot bypass opt-out.
export const suppressionKey = (config, email) => `${config.prefix}suppressed:${hash(email.toLowerCase())}`;
export const mailOptoutKey = (config, token) => `${config.prefix}optout:${hash(token)}`;
export async function optOutMail(config,token,kv=mailKv(config)) {
  if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token))return {status:'invalid'};
  const key=mailOptoutKey(config,token);const sk=await kv(['GET',key]);
  if(sk===null)return {status:'unknown'};
  const prefix=`${config.prefix}suppressed:`;
  if(typeof sk!=='string' || !sk.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(sk.slice(prefix.length)))throw Error('invalid opt-out record');
  const result=await kv(['EVAL',APPLY_MAIL_OPTOUT,'2',key,sk,JSON.stringify({version:1,reason:'opt-out',evidenceHash:hash(token)})]);
  if(!['opted-out','unknown'].includes(result))throw Error('invalid storage result');
  return {status:result};
}
export async function suppressMailRecipient(config, record, kv = mailKv(config)) {
  const email=normalizeMailAddress(record?.email);
  if(!email || !['bounce','complaint','opt-out'].includes(record?.reason) || typeof record?.evidenceId!=='string' || !record.evidenceId.trim() || record.evidenceId.length>200) throw Error('A valid recipient, suppression reason and evidence ID are required.');
  // No expiry: consent re-import and elapsed time must never reactivate mail.
  await kv(['SET',suppressionKey(config,email),JSON.stringify({version:1,reason:record.reason,evidenceHash:hash(record.evidenceId)}),'NX']);
}
export function validMailBinding(b, wallet, email, now = Date.now()) {
  return b && id(b.version) && b.wallet === wallet && b.email === email && b.revoked === false && Number.isSafeInteger(b.verifiedAt) && b.verifiedAt > 0 && b.verifiedAt <= now && Number.isSafeInteger(b.consentedAt) && b.consentedAt >= b.verifiedAt && b.consentedAt <= now && Number.isSafeInteger(b.expiresAt) && b.expiresAt > now && typeof b.evidenceId === 'string' && b.evidenceId.length > 0 && b.evidenceId.length <= 200;
}
function encrypt(config, value, aad) {
  const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',config.key,iv); cipher.setAAD(Buffer.from(aad));
  const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return JSON.stringify({ iv:iv.toString('hex'), tag:cipher.getAuthTag().toString('hex'), data:data.toString('base64') });
}
function decrypt(config, raw, aad) {
  const e=JSON.parse(raw); const cipher=createDecipheriv('aes-256-gcm',config.key,Buffer.from(e.iv,'hex')); cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(Buffer.from(e.tag,'hex'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(e.data,'base64')),cipher.final()]).toString());
}
export function createMailService(config, kv = mailKv(config), request = fetch) {
  const queue = `${config.prefix}queue`;
  const jobKey = c => `${config.prefix}job:${hash(`${c.wallet}\n${c.id}`)}`;
  const heartbeat = `${config.prefix}worker:last-success`;
  return {
    async workerStatus() {
      const [now,queued,due,oldestDueAgeMs,lastSuccessfulTickAt] = await kv(['EVAL',MAIL_WORKER_STATUS,'2',queue,heartbeat]);
      const workerHealthy = lastSuccessfulTickAt>0 && lastSuccessfulTickAt<=now && now-lastSuccessfulTickAt<=300000 && oldestDueAgeMs<=300000;
      return {status:workerHealthy?'ok':'degraded',workerHealthy,checkedAt:now,queued,due,oldestDueAgeMs,lastSuccessfulTickAt:lastSuccessfulTickAt||null};
    },
    async execute(c) {
      const key=jobKey(c);
      if (c.action==='status') { const raw=await kv(['GET',key]); return { status:raw?JSON.parse(raw).status:'unknown', id:c.id }; }
      const digest=hash(JSON.stringify([c.service,c.wallet,c.id,c.to,c.subject,c.text]));
      // A retry must report the existing outcome even if permission was revoked
      // after enqueue; denial must not imply that an earlier attempt never sent.
      const prior=await kv(['GET',key]);
      if(prior) { const job=JSON.parse(prior); return {status:job.digest===digest?job.status:'conflict',id:c.id}; }
      if (!config.senders.includes(c.wallet)) return { status:'denied', id:c.id };
      const bk=bindingKey(config,c.wallet,c.to); const raw=await kv(['GET',bk]); const b=raw?JSON.parse(raw):null;
      if (!validMailBinding(b,c.wallet,c.to)) return { status:'denied', id:c.id };
      const identityScope=config.identity?mailIdentityScope(b,c.wallet,hash(key),digest):null;
      if(config.identity&&!await resolveMailIdentity(config.identity,identityScope,c.to,request))return {status:'denied',id:c.id};
      const optoutToken=randomBytes(32).toString('hex');
      const optoutUrl=new URL('/mail/optout/',config.service);optoutUrl.hash=`token=${optoutToken}`;
      const payload={ from:config.from,to:[c.to],subject:c.subject,headers:{'X-Chat-Bridge':'wallet-to-email'},text:`Sent through Chat by wallet ${c.wallet}.\nThis email was authorized by a wallet signature. Email is not end-to-end encrypted wallet chat. Replies to this service address are not forwarded.\n\n${c.text}\n\nStop future Chat email to this address (confirmation required): ${optoutUrl.href}` };
      const sk=suppressionKey(config,c.to);
      const record={identityService:config.identity?.url||null,identityScope,digest,wallet:c.wallet,id:c.id,bindingKey:bk,bindingVersion:b.version,suppressionKey:sk};
      const [status]=await kv(['EVAL',ENQUEUE_MAIL,'8',key,queue,bk,`${config.prefix}quota:wallet:${c.wallet}`,`${config.prefix}quota:email:${hash(c.to.toLowerCase())}`,`${key}:payload`,sk,mailOptoutKey(config,optoutToken),digest,JSON.stringify(record),b.version,encrypt(config,payload,key),String(c.expiresAt)]);
      return {status,id:c.id};
    },
    async drain() {
      const clock=await kv(['TIME']); const now=Number(clock[0])*1000+Math.floor(Number(clock[1])/1000);
      const keys=await kv(['ZRANGEBYSCORE',queue,'-inf',String(now),'LIMIT','0','1']);
      let processed=0;
      for (const key of keys) {
        if (typeof key!=='string' || !key.startsWith(`${config.prefix}job:`)) throw Error('invalid job');
        const raw=await kv(['GET',key]); if (!raw) { await kv(['ZREM',queue,key]); continue; }
        const known=JSON.parse(raw); const lease=randomBytes(16).toString('hex');
        const claimed=await kv(['EVAL',CLAIM_MAIL,'5',key,queue,known.bindingKey,`${key}:payload`,known.suppressionKey||`${config.prefix}legacy-suppression-placeholder`,lease]);
        if (!claimed) continue;
        const [record,encrypted]=claimed; const job=JSON.parse(record);
        let outcome='queued'; let providerId='';
        try {
          if (!config.senders.includes(job.wallet)) outcome='stopped';
          else {
            const payload=decrypt(config,encrypted,key);
            // A queued Wallet-scoped job must never downgrade to imported-only authority.
            const identityRequired=!!(config.identity||job.identityScope);
            const identityAllowed=!identityRequired||(job.identityService===config.identity?.url&&await resolveMailIdentity(config.identity,job.identityScope,payload.to[0],request));
            // Check local revocation/suppression after the network authorization request.
            const br=await kv(['GET',job.bindingKey]); const binding=br?JSON.parse(br):null;
            const suppressed=await kv(['EXISTS',suppressionKey(config,payload.to[0])]);
            if (!identityAllowed || suppressed || !validMailBinding(binding,job.wallet,payload.to[0]) || binding.version!==job.bindingVersion) outcome='stopped';
            else {
              const response=await request('https://api.resend.com/emails',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.providerKey}`,'Content-Type':'application/json','Idempotency-Key':`chirpy-mail/${hash(config.service)}/${job.wallet}/${job.id}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
              if (response.ok) { const result=await response.json(); if (typeof result.id==='string' && result.id.length<=200 && result.id) { outcome='accepted'; providerId=result.id; } }
              else if (response.status>=400 && response.status<500 && ![408,409,429].includes(response.status)) outcome='stopped';
            }
          }
        } catch { /* Keep the immutable payload and idempotency key for bounded retries. */ }
        await kv(['EVAL',FINISH_MAIL,'3',key,queue,`${key}:payload`,lease,outcome,providerId]); processed++;
      }
      await kv(['EVAL',MAIL_WORKER_HEARTBEAT,'1',heartbeat]);
      return {processed};
    },
  };
}
