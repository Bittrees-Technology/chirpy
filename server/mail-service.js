import {reconcileSmtpReceipts,indexSmtpHolds} from './mail-smtp-reconciliation.js';
import {mailDeliveryKey} from './mail-delivery.js';
import { mailIdentityConfig, mailIdentityScope, resolveMailIdentity } from './mail-identity.js';
import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import { normalizeMailAddress, mailSignMessage, parseMailReceiptDetails, parseMailDeliveryDetails } from '../packages/core/src/mailAuth.js';
import { ENQUEUE_MAIL, CLAIM_MAIL, FINISH_MAIL, MAIL_WORKER_STATUS, MAIL_WORKER_HEARTBEAT, APPLY_MAIL_OPTOUT, LIST_MAIL_HISTORY, PIN_SMTP_REFERENCE, AUTHORIZE_SMTP } from './mail-store.js';
export const hash = value => createHash('sha256').update(value).digest('hex');
const address = value => typeof value === 'string' && /^0x[a-f0-9]{40}$/.test(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function mailConfig(env = process.env, { deliveryIdentity = true } = {}) {
  if (env.CHIRPY_MAIL_ENABLED !== '1' || (env.VERCEL_ENV && env.VERCEL_ENV !== 'production')) return null;
  try {
    const service = new URL(env.CHIRPY_MAIL_SERVICE_URL);
    const kvUrl = new URL(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL);
    const from = normalizeMailAddress(env.CHIRPY_MAIL_FROM);
    const provider = env.CHIRPY_MAIL_PROVIDER ?? 'resend';
    if(!['resend','smtp'].includes(provider))return null; // Never fall back across providers.
    const smtpProfile=env.CHAT_SMTP_PROFILE;
    if(provider==='smtp'&&!/^[a-f0-9]{64}$/.test(smtpProfile||''))return null;
    const identity=deliveryIdentity?mailIdentityConfig(env):null;
    if(provider==='smtp'&&deliveryIdentity&&!identity)return null;
    const senders = String(env.CHIRPY_MAIL_SENDERS || '').split(',').map(v => v.trim().toLowerCase());
    if (service.protocol !== 'https:' || service.pathname !== '/api/mail' || service.search || service.hash || service.username || service.password || kvUrl.protocol !== 'https:' || kvUrl.username || kvUrl.password || !from || !senders.length || !senders.every(address) || !/^[a-f0-9]{64}$/.test(env.CHIRPY_MAIL_DATA_KEY || '') || (env.CHIRPY_MAIL_WORKER_SECRET || '').length < 32 || (provider==='resend'&&!env.RESEND_API_KEY) || !(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN)) return null;
    return { provider, smtpProfile, identity, service: service.href, kvUrl: kvUrl.href, kvToken: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN, from, senders, key: Buffer.from(env.CHIRPY_MAIL_DATA_KEY, 'hex'), providerKey: env.RESEND_API_KEY, workerSecret: env.CHIRPY_MAIL_WORKER_SECRET, prefix: `chirpy:mail:${hash(service.href)}:` };
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
  if (!c || !['send','status','history'].includes(c.action) || c.service !== service || !address(c.wallet) || !id(c.id) || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= now || c.expiresAt > now+300000) return false;
  if(c.action==='history')return Object.keys(c).sort().join(',')==='action,cursor,expiresAt,id,service,wallet'&&(c.cursor===null||typeof c.cursor==='string'&&/^[a-f0-9]{64}$/.test(c.cursor));
  if (c.action === 'status') return true;
  return normalizeMailAddress(c.to) === c.to && typeof c.subject === 'string' && c.subject.trim().length > 0 && c.subject.length <= 120 && !/[\x00-\x1f\x7f]/.test(c.subject) && typeof c.text === 'string' && c.text.trim().length > 0 && Buffer.byteLength(c.text) <= 16384 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c.text);
}
export async function verifyMailCommand(c, signature, service, now) {
  if (!validMailCommand(c, service, now) || typeof signature !== 'string' || !/^0x[a-fA-F0-9]{130}$/.test(signature)) return false;
  try { return (await recoverMessageAddress({ message: mailSignMessage(c), signature })).toLowerCase() === c.wallet; } catch { return false; }
}
export const bindingKey = (config, wallet, email) => `${config.prefix}binding:${hash(`${wallet}\n${email}`)}`;
export const mailHistoryKey = (config,wallet) => `${config.prefix}history:${hash(wallet)}`;
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
export function createMailService(config, kv = mailKv(config), request = fetch, smtp = null) {
  // Capture delivery routing before any asynchronous storage or authority call.
  // Credential rotation may change provider accounts, so it is not an implicit migration.
  if(!['resend','smtp'].includes(config.provider)||config.provider==='resend'&&(typeof config.providerKey!=='string'||!config.providerKey)||config.provider==='smtp'&&!/^[a-f0-9]{64}$/.test(config.smtpProfile||'')||!Buffer.isBuffer(config.key)||config.key.length!==32)throw Error('Invalid delivery provider configuration');
  const routing={...config,key:Buffer.from(config.key)};
  const providerKey=routing.providerKey,from=routing.from;
  const deliveryProvider=routing.provider+'-v1:'+createHmac('sha256',routing.key).update(JSON.stringify(['Chat mail provider v1',routing.service,from,routing.provider==='smtp'?routing.smtpProfile:providerKey])).digest('hex');
  if(smtp&&(routing.provider!=='smtp'||smtp.profile!==routing.smtpProfile))throw Error('SMTP transport profile mismatch');
  const queue = `${routing.prefix}queue`;
  const jobKey = c => `${routing.prefix}job:${hash(`${c.wallet}\n${c.id}`)}`;
  const heartbeat = `${routing.prefix}worker:last-success`;
  return {
    async workerStatus() {
      const [now,queued,due,oldestDueAgeMs,lastSuccessfulTickAt,blocked,uncertainCount] = await kv(['EVAL',MAIL_WORKER_STATUS,'3',queue,heartbeat,`${queue}:uncertain`,deliveryProvider]);
      if(!Number.isSafeInteger(now)||now<=0||![queued,due,oldestDueAgeMs,lastSuccessfulTickAt,uncertainCount].every(v=>Number.isSafeInteger(v)&&v>=0)||due>queued||blocked!==0&&blocked!==1)throw Error('Invalid worker status');
      const providerBlocked=blocked===1;
      const journal=smtp?smtp.summary():null;
      const journalUncertainCount=journal?.uncertainCount??null;
      const journalStaleUncertainCount=journal?.staleUncertainCount??null;
      const workerHealthy = !providerBlocked && uncertainCount===0 && (!smtp||journalStaleUncertainCount===0) && lastSuccessfulTickAt>0 && lastSuccessfulTickAt<=now && now-lastSuccessfulTickAt<=300000 && oldestDueAgeMs<=300000;
      return {status:workerHealthy?'ok':'degraded',workerHealthy,providerBlocked,uncertainCount,...(smtp?{journalUncertainCount,journalStaleUncertainCount}:{}),checkedAt:now,queued,due,oldestDueAgeMs,lastSuccessfulTickAt:lastSuccessfulTickAt||null};
    },
    async indexHolds(options={}) {
      if(routing.provider!=='smtp'||!smtp)throw Error('Private SMTP worker required');
      smtp.check();
      return indexSmtpHolds({routing,deliveryProvider,kv},options);
    },
    async reconcile(options={}) {
      if(routing.provider!=='smtp'||!smtp)throw Error('Private SMTP worker required');
      smtp.check();
      return reconcileSmtpReceipts({routing,deliveryProvider,smtp,kv},options);
    },
    async execute(c) {
      const key=jobKey(c);
      if(c.action==='history'){
        const prefix=`${routing.prefix}job:`;
        const result=await kv(['EVAL',LIST_MAIL_HISTORY,'1',mailHistoryKey(routing,c.wallet),String(c.expiresAt),c.cursor?prefix+c.cursor:'']);
        if(!Array.isArray(result)||!result.length)throw Error('Invalid forwarding history.');
        const [status,...keys]=result;
        if(['expired','history-changed'].includes(status)&&!keys.length)return {status,id:c.id};
        if(status!=='history'||keys.length>26||new Set(keys).size!==keys.length||keys.some(value=>typeof value!=='string'||!value.startsWith(prefix)||!/^[a-f0-9]{64}$/.test(value.slice(prefix.length))))throw Error('Invalid forwarding history.');
        const page=keys.slice(0,25),rows=page.length?await kv(['MGET',...page]):[];
        if(!Array.isArray(rows)||rows.length!==page.length)throw Error('Invalid forwarding history.');
        const ids=[];
        for(let i=0;i<rows.length;i++){
          if(rows[i]===null)continue;
          const job=JSON.parse(rows[i]);
          if(job.wallet!==c.wallet||!id(job.id)||jobKey(job)!==page[i])throw Error('Invalid forwarding history owner.');
          parseMailReceiptDetails({version:1,createdAt:job.createdAt,updatedAt:job.updatedAt??null,attempts:job.attempts,retryUntil:job.deadline},job.status);
          ids.push(job.id);
        }
        return {status:'history',id:c.id,service:c.service,wallet:c.wallet,cursor:c.cursor,ids,nextCursor:keys.length>25?page.at(-1).slice(prefix.length):null};
      }
      if (c.action==='status') {
        const raw=await kv(['GET',key]);
        if(!raw)return {status:'unknown',id:c.id};
        const job=JSON.parse(raw);
        if(job.wallet!==c.wallet||job.id!==c.id)throw Error('Invalid forwarding receipt owner.');
        const receipt=parseMailReceiptDetails({version:1,createdAt:job.createdAt,updatedAt:job.updatedAt??null,attempts:job.attempts,retryUntil:job.deadline},job.status);
        let delivery;
        const recipientPrefix=`${routing.prefix}suppressed:`;
        if(job.status==='accepted'&&typeof job.providerId==='string'&&job.providerId.length>0&&job.providerId.length<=200&&typeof job.suppressionKey==='string'&&job.suppressionKey.startsWith(recipientPrefix)&&/^[a-f0-9]{64}$/.test(job.suppressionKey.slice(recipientPrefix.length))){
          const evidence=await kv(['GET',mailDeliveryKey(routing,job.providerId,job.suppressionKey)]);
          if(evidence!==null&&(typeof evidence!=='string'||Buffer.byteLength(evidence)>2048))throw Error('Invalid provider delivery evidence.');
          delivery=parseMailDeliveryDetails(evidence===null?{version:1,events:[]}:JSON.parse(evidence));
        }
        return {status:job.status,id:c.id,receipt,...(delivery?{delivery}:{})};
      }
      const digest=hash(JSON.stringify([c.service,c.wallet,c.id,c.to,c.subject,c.text]));
      // A retry must report the existing outcome even if permission was revoked
      // after enqueue; denial must not imply that an earlier attempt never sent.
      const prior=await kv(['GET',key]);
      if(prior) { const job=JSON.parse(prior); return {status:job.digest===digest?job.status:'conflict',id:c.id}; }
      if (!config.senders.includes(c.wallet)) return { status:'denied', id:c.id };
      const bk=bindingKey(routing,c.wallet,c.to); const raw=await kv(['GET',bk]); const b=raw?JSON.parse(raw):null;
      if (!validMailBinding(b,c.wallet,c.to)) return { status:'denied', id:c.id };
      const identityScope=config.identity?mailIdentityScope(b,c.wallet,hash(key),digest):null;
      if(config.identity&&!await resolveMailIdentity(config.identity,identityScope,c.to,request))return {status:'denied',id:c.id};
      const optoutToken=randomBytes(32).toString('hex');
      const optoutUrl=new URL('/mail/optout/',routing.service);optoutUrl.hash=`token=${optoutToken}`;
      const payload={ from,to:[c.to],subject:c.subject,headers:{'X-Chat-Bridge':'wallet-to-email'},text:`Sent through Chat by wallet ${c.wallet}.\nThis email was authorized by a wallet signature. Email is not end-to-end encrypted wallet chat. Replies to this service address are not forwarded.\n\n${c.text}\n\nStop future Chat email to this address (confirmation required): ${optoutUrl.href}` };
      const sk=suppressionKey(routing,c.to);
      const record={deliveryProvider,identityService:config.identity?.url||null,identityScope,digest,wallet:c.wallet,id:c.id,bindingKey:bk,bindingVersion:b.version,suppressionKey:sk};
      const [status]=await kv(['EVAL',ENQUEUE_MAIL,'9',key,queue,bk,`${routing.prefix}quota:wallet:${c.wallet}`,`${routing.prefix}quota:email:${hash(c.to.toLowerCase())}`,`${key}:payload`,sk,mailOptoutKey(routing,optoutToken),mailHistoryKey(routing,c.wallet),digest,JSON.stringify(record),b.version,encrypt(routing,payload,key),String(c.expiresAt)]);
      return {status,id:c.id};
    },
    async drain() {
      // Vercel can enqueue/read SMTP receipts, but only the private adapter may claim work.
      if(routing.provider==='smtp'){if(!smtp)throw Error('Private SMTP worker required');smtp.check();}
      const clock=await kv(['TIME']); const now=Number(clock[0])*1000+Math.floor(Number(clock[1])/1000);
      const keys=await kv(['ZRANGEBYSCORE',queue,'-inf',String(now),'LIMIT','0','1']);
      let processed=0,uncertain=0;
      for (const key of keys) {
        if (typeof key!=='string' || !key.startsWith(`${routing.prefix}job:`)) throw Error('invalid job');
        const raw=await kv(['GET',key]); if (!raw) { await kv(['ZREM',queue,key]); continue; }
        const known=JSON.parse(raw); const lease=randomBytes(16).toString('hex');
        const claimed=await kv(['EVAL',CLAIM_MAIL,'5',key,queue,known.bindingKey,`${key}:payload`,known.suppressionKey||`${routing.prefix}legacy-suppression-placeholder`,lease,deliveryProvider]);
        if (!claimed) continue;
        if(claimed.length===1&&claimed[0]==='provider-mismatch')throw Error('Delivery provider does not match the queued request');
        if(claimed.length!==2)throw Error('Invalid delivery claim');
        const [record,encrypted]=claimed; const job=JSON.parse(record);
        if(job.deliveryProvider!==deliveryProvider)throw Error('Delivery provider does not match the queued request');
        if(routing.provider==='smtp'){
          const requestId=`chirpy-mail/${hash(routing.service)}/${job.wallet}/${job.id}`;
          let result={status:'unknown'};
          if(job.smtpReference){
            if(job.smtpReference.requestId!==requestId||job.smtpReference.deadline!==job.deadline)throw Error('Invalid SMTP recovery scope');
            result=smtp.recover(job.smtpReference);
          }
          if(['unknown','retryable'].includes(result.status)){
            // No previous potentially accepted submission, or definitive nonacceptance.
            if(!encrypted||Date.now()>=job.deadline||!config.senders.includes(job.wallet))result={status:'denied'};
            else {
              const payload=decrypt(routing,encrypted,key);
              const command={requestId,deadline:job.deadline,payload};
              const reference=smtp.reference(command);
              if(await kv(['EVAL',PIN_SMTP_REFERENCE,'1',key,lease,JSON.stringify(reference)])!==1)throw Error('SMTP reference or lease changed');
              result=await smtp.submit(command,async()=>{
                const identityAllowed=!!config.identity&&job.identityService===config.identity.url&&await resolveMailIdentity(config.identity,job.identityScope,payload.to[0],request);
                const br=await kv(['GET',job.bindingKey]);const binding=br?JSON.parse(br):null;
                if(!identityAllowed||!config.senders.includes(job.wallet)||!validMailBinding(binding,job.wallet,payload.to[0])||binding.version!==job.bindingVersion)return false;
                return await kv(['EVAL',AUTHORIZE_SMTP,'4',key,job.bindingKey,suppressionKey(routing,payload.to[0]),`${key}:payload`,lease,reference.digest])===1;
              });
            }
          }
          const outcomes={accepted:'accepted',uncertain:'uncertain',rejected:'stopped',denied:'stopped',expired:'stopped',retryable:'queued'};
          if(!Object.hasOwn(outcomes,result.status))throw Error('Invalid SMTP outcome');
          // Adapter/journal/storage errors deliberately leave the claim for recovery.
          if(await kv(['EVAL',FINISH_MAIL,'4',key,queue,`${key}:payload`,`${queue}:uncertain`,lease,outcomes[result.status],result.id||''])!==1)throw Error('SMTP completion lease changed');
          processed++;if(result.status==='uncertain')uncertain++;continue;
        }
        let outcome='queued'; let providerId='';
        try {
          if (!config.senders.includes(job.wallet)) outcome='stopped';
          else {
            const payload=decrypt(routing,encrypted,key);
            // A queued Wallet-scoped job must never downgrade to imported-only authority.
            const identityRequired=!!(config.identity||job.identityScope);
            const identityAllowed=!identityRequired||(job.identityService===config.identity?.url&&await resolveMailIdentity(config.identity,job.identityScope,payload.to[0],request));
            // Check local revocation/suppression after the network authorization request.
            const br=await kv(['GET',job.bindingKey]); const binding=br?JSON.parse(br):null;
            const suppressed=await kv(['EXISTS',suppressionKey(routing,payload.to[0])]);
            if (!identityAllowed || suppressed || !validMailBinding(binding,job.wallet,payload.to[0]) || binding.version!==job.bindingVersion) outcome='stopped';
            else {
              const response=await request('https://api.resend.com/emails',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${providerKey}`,'Content-Type':'application/json','Idempotency-Key':`chirpy-mail/${hash(routing.service)}/${job.wallet}/${job.id}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
              if (response.ok) { const result=await response.json(); if (typeof result.id==='string' && result.id.length<=200 && result.id) { outcome='accepted'; providerId=result.id; } }
              else if (response.status>=400 && response.status<500 && ![408,409,429].includes(response.status)) outcome='stopped';
            }
          }
        } catch { /* Keep the immutable payload and idempotency key for bounded retries. */ }
        await kv(['EVAL',FINISH_MAIL,'4',key,queue,`${key}:payload`,`${queue}:uncertain`,lease,outcome,providerId]); processed++;
      }
      await kv(['EVAL',MAIL_WORKER_HEARTBEAT,'1',heartbeat]);
      return routing.provider==='smtp'?{processed,uncertain}:{processed};
    },
  };
}
