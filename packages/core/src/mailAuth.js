export function normalizeMailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\x00-\x20\x7f]/.test(value)) return null;
  const parts = value.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[a-zA-Z0-9!#$&'*+\-/=^_`{|}~]+(?:\.[a-zA-Z0-9!#$&'*+\-/=^_`{|}~]+)*$/.test(local)) return null;
  if (!domain.includes('.') || !domain.split('.').every(p => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(p))) return null;
  return `${local}@${domain.toLowerCase()}`;
}
export function mailSignMessage(command) {
  if(command.action==='history')return ['Chat forwarding request discovery v1',`Service: ${command.service}`,`Wallet: ${command.wallet}`,`Request: ${command.id}`,`Before: ${command.cursor??'first page'}`,`Signature expires: ${command.expiresAt}`,'Read up to 25 retained forwarding request IDs for this wallet. This does not authorize sending email, transactions, or account changes.'].join('\n');
  const lines = ['Chirpy wallet-to-email v1', `Service: ${command.service}`, `Action: ${command.action}`, `Wallet: ${command.wallet}`, `Request: ${command.id}`, `Signature expires: ${command.expiresAt}`];
  if (command.action === 'send') lines.push(`Recipient: ${command.to}`, `Subject: ${command.subject}`, 'Authorize this email and queue retries for up to 23 hours. The email provider can read it. No blockchain transaction.', 'Message:', command.text);
  return lines.join('\n');
}

// Receipt details describe queue activity, never delivery or read confirmation.
export function parseMailReceiptDetails(value, status) {
  const timestamp = n => Number.isSafeInteger(n) && n > 0 && n <= 8640000000000000;
  if (!value || Object.keys(value).sort().join(',') !== 'attempts,createdAt,retryUntil,updatedAt,version' || value.version !== 1 ||
      !['queued','sending','accepted','stopped'].includes(status) || !timestamp(value.createdAt) || !timestamp(value.retryUntil) ||
      value.retryUntil-value.createdAt !== 82800000 || !(value.updatedAt === null || timestamp(value.updatedAt) && value.updatedAt >= value.createdAt) ||
      !Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > 5 ||
      ['sending','accepted'].includes(status) && value.attempts === 0 || status === 'queued' && value.attempts >= 5) throw Error('Invalid forwarding receipt.');
  return {version:1,createdAt:value.createdAt,updatedAt:value.updatedAt,attempts:value.attempts,retryUntil:value.retryUntil};
}

export const MAIL_DELIVERY_EVENTS=Object.freeze(['sent','delivered','delivery_delayed','failed','bounced','complained','suppressed']);
export function parseMailDeliveryDetails(value) {
 if(!value||Object.keys(value).sort().join(',')!=='events,version'||value.version!==1||!Array.isArray(value.events)||value.events.length>7)throw Error('Invalid provider delivery evidence.');
 const seen=new Set();
 const events=value.events.map(event=>{
  if(!event||Object.keys(event).sort().join(',')!=='occurredAt,type'||!MAIL_DELIVERY_EVENTS.includes(event.type)||seen.has(event.type)||!Number.isSafeInteger(event.occurredAt)||event.occurredAt<=0||event.occurredAt>8640000000000000)throw Error('Invalid provider delivery evidence.');
  seen.add(event.type);return {type:event.type,occurredAt:event.occurredAt};
 });
 events.sort((a,b)=>a.occurredAt-b.occurredAt||a.type.localeCompare(b.type));return {version:1,events};
}
