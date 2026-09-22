import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeMailAddress } from '../packages/core/src/mailAuth.js';

export const INBOUND_MAIL_SOURCE = 'https://mail.bittrees.org';
export const INBOUND_MAIL_SERVICE = 'https://chat.bittrees.org/api/mail-inbound';
export const INBOUND_MAIL_MAX_BYTES = 65536;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const header = value => typeof value === 'string' && Buffer.byteLength(value) <= 1000 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
const fields = ['version','source','id','mailbox','bindingId','bindingVersion','messageId','sourceVersion','receivedAt','from','subject','text','truncated','automated','bridgeDepth'];

export const inboundMailId = (mailbox,messageId) => sha256(JSON.stringify([INBOUND_MAIL_SOURCE,mailbox,messageId]));

// These values come only from an authenticated, mailbox-authorized Mail connector.
// From is provenance, never evidence that the email author controls a wallet.
export function validInboundMail(event, now = Date.now()) {
  return !!event && !Array.isArray(event) && typeof event === 'object' && Object.keys(event).length === fields.length && fields.every(k => Object.hasOwn(event,k)) &&
    event.version === 1 && event.source === INBOUND_MAIL_SOURCE && hex(event.id) &&
    normalizeMailAddress(event.mailbox) === event.mailbox && !!event.mailbox &&
    typeof event.bindingId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(event.bindingId) && Number.isSafeInteger(event.bindingVersion) && event.bindingVersion > 0 &&
    hex(event.messageId) && event.id === inboundMailId(event.mailbox,event.messageId) && hex(event.sourceVersion) && Number.isSafeInteger(event.receivedAt) && event.receivedAt <= now + 30000 && event.receivedAt > now - 23*3600000 &&
    header(event.from) && header(event.subject) && typeof event.text === 'string' && Buffer.byteLength(event.text) <= 16000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(event.text) &&
    typeof event.truncated === 'boolean' && event.automated === false && event.bridgeDepth === 0;
}

// Scope is deliberately independent of transport header timestamps and JSON order.
export function inboundMailScope(event) {
  return { bindingId:event.bindingId, expectedVersion:event.bindingVersion, mailbox:event.mailbox,
    deliveryId:sha256(JSON.stringify([event.source,event.mailbox,event.id])),
    contentHash:sha256(JSON.stringify(fields.map(k=>event[k]))) };
}

export function signInboundMail(raw, timestamp, secret) {
  if(!Buffer.isBuffer(raw)||raw.length>INBOUND_MAIL_MAX_BYTES||!hex(secret)||!Number.isSafeInteger(timestamp))throw Error('Invalid inbound signing input');
  return createHmac('sha256',Buffer.from(secret,'hex')).update(`chat-mail-inbound-v1\n${INBOUND_MAIL_SERVICE}\n${INBOUND_MAIL_SOURCE}\n${timestamp}\n${sha256(raw)}`).digest('hex');
}

export function authenticateInboundMail(raw, timestampHeader, signature, secret, now = Date.now()) {
  if(!Buffer.isBuffer(raw)||raw.length>INBOUND_MAIL_MAX_BYTES||!hex(secret)||!hex(signature)||typeof timestampHeader!=='string'||!/^\d{13}$/.test(timestampHeader))return null;
  const timestamp=Number(timestampHeader);
  if(timestamp < now-300000 || timestamp > now+30000)return null;
  const expected=signInboundMail(raw,timestamp,secret);
  if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))return null;
  try {
    // Reject invalid UTF-8 instead of accepting replacement characters.
    const event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    if(!validInboundMail(event,now))return null;
    return {event,scope:inboundMailScope(event)};
  } catch { return null; }
}

export function inboundMailText(event) {
  if(!validInboundMail(event))throw Error('Invalid inbound email');
  return `Email forwarded by Chat from your connected Mail account.\nThe From header below is email provenance, not verified wallet identity.\n\nFrom: ${event.from}\nSubject: ${event.subject}\n\n${event.text}\n\n${event.truncated?'[Email text shortened; open Mail for the original.]\n':''}Bridge reference: ${event.id}\nReplying here messages the Chat bridge, not the original email sender.`;
}
