// Self-hosted only: one bounded queue attempt, using the durable local journal.
import { randomBytes } from 'node:crypto';
import { hash, mailKv } from './mail-service.js';
import { decodeInboundMail, resolveInboundMail } from './inbound-mail.js';
import { validInboundMail, inboundMailScope } from './inbound-mail-contract.js';
import { inboundSenderIdentity } from './inbound-xmtp-sender.js';
import { checkInboundSource } from './inbound-source-process.js';
import { sendInboundInProcess } from './inbound-sender-process.js';
import { CLAIM_INBOUND_JOB, FENCE_INBOUND_JOB, FINISH_INBOUND_JOB } from './inbound-queue-store.js';

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function runInboundMailJob({config, journal, childConfig, processConfig}, {
  storage = mailKv(config), sourceCheck = checkInboundSource,
  recipientCheck = resolveInboundMail, send = sendInboundInProcess,
} = {}) {
  if (!config || childConfig?.enabled !== true || childConfig.identity?.url !== config.identity?.url) {
    throw Error('Inbound worker configuration mismatch');
  }
  journal.assertIdentity(inboundSenderIdentity(childConfig));
  const token = randomBytes(32).toString('hex');
  const queue = `${config.prefix}queue`, prefix = `${config.prefix}job:`;
  const raw = await storage(['EVAL', CLAIM_INBOUND_JOB, '1', queue, prefix, token]);
  if (!raw) return {status:'idle'};
  if (typeof raw !== 'string' || raw.length > 8192) throw Error('Invalid claim response');
  const {key, job} = JSON.parse(raw);
  if (typeof key !== 'string' || !key.startsWith(prefix) || !hex(key.slice(prefix.length)) ||
    !job || !hex(job.id) || !hex(job.digest) || job.token !== token || job.status !== 'sending') {
    throw Error('Invalid queue claim');
  }
  const finish = async (status, receipt) => {
    const outcome = await storage(['EVAL', FINISH_INBOUND_JOB, '3', key, `${key}:payload`, queue,
      token, status, receipt ? hash(JSON.stringify(receipt)) : '']);
    if (!['queued','published','stopped','uncertain','missing','superseded'].includes(outcome)) throw Error('Invalid queue outcome');
    return {status:outcome, id:job.id};
  };
  // Positive local evidence wins even after payload expiry or a lost Redis ack.
  // This never opens the SDK or uses an absent local message as non-delivery proof.
  const prior = journal.outcome(job.id, job.digest);
  if (prior.status === 'published') return finish('published', prior.receipt);
  if (prior.status === 'uncertain') return finish('uncertain');
  if (journal.inspect().blocked) return finish('queued');
  if (job.identityService !== config.identity.url || !Number.isSafeInteger(job.deadline) || job.deadline <= Date.now()) return finish('stopped');
  const encrypted = await storage(['GET', `${key}:payload`]);
  if (!encrypted) return finish('stopped');
  let payload;
  try {
    if (typeof encrypted !== 'string' || encrypted.length > 262144) throw Error('Oversized payload');
    payload = decodeInboundMail(config, encrypted, key);
    const {event,scope,recipient} = payload;
    if (Object.keys(payload).length !== 3 || !validInboundMail(event) || event.id !== job.id || !config.mailboxes.includes(event.mailbox)) throw Error('Invalid event');
    const expected = inboundMailScope(event);
    if (!scope || Object.keys(scope).length !== 5 || !Object.keys(expected).every(k => scope[k] === expected[k]) ||
      scope.contentHash !== job.digest || key !== prefix + scope.deliveryId || !recipient || Object.keys(recipient).length !== 2 ||
      !/^0x[a-f0-9]{40}$/.test(recipient.wallet || '') || !Number.isSafeInteger(recipient.expiresAt) ||
      recipient.expiresAt <= Date.now() || job.deadline > Math.min(event.receivedAt + 23*3600000, recipient.expiresAt)) throw Error('Invalid queued scope');
  } catch { return finish('stopped'); }
  // Transient preflight failures may retry because no journal attempt exists.
  // The sender repeats authority checks immediately before publishing.
  try {
    if (await sourceCheck(childConfig.source, payload.event) !== true) return finish('stopped');
    const recipient = await recipientCheck(config, payload.scope);
    if (!recipient || recipient.wallet !== payload.recipient.wallet || recipient.expiresAt <= Date.now()) return finish('stopped');
  } catch { return finish('queued'); }
  if (await storage(['EVAL', FENCE_INBOUND_JOB, '2', key, `${key}:payload`, token]) !== 1) return {status:'superseded',id:job.id};
  let result;
  try { result = await send(journal, processConfig, payload.event, payload.recipient); }
  catch {
    // An exception may follow a committed journal write. Never assume failure
    // means no publication and never reset an armed attempt.
    result = {status:'uncertain'};
  }
  const final = journal.outcome(job.id, job.digest);
  if (final.status === 'published') return finish('published', final.receipt);
  if (final.status === 'uncertain') return finish('uncertain');
  // A sender must persist its own outcome. A returned success without journal
  // evidence is not sufficient to label the queue item published.
  if (result?.status === 'blocked') return finish('queued');
  return finish('uncertain');
}
