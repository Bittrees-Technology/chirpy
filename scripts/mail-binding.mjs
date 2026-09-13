// Trusted verification-authority import/revocation. Never expose this as a browser API.
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { mailConfig, mailKv, bindingKey, validMailBinding } from '../server/mail-service.js';
import { normalizeMailAddress } from '../packages/core/src/mailAuth.js';
const config=mailConfig(); if(!config) throw Error('Configure the disabled pilot before importing verified consent.');
const [action,path]=process.argv.slice(2);
if(!['import','revoke'].includes(action)||!path) throw Error('Usage: mail-binding.mjs import|revoke private-record.json');
const raw=await readFile(path); if(raw.byteLength>4096) throw Error('Record is too large.');
const record=JSON.parse(raw.toString()); const email=normalizeMailAddress(record.email); const wallet=String(record.wallet||'').toLowerCase();
if(!email||!/^0x[a-f0-9]{40}$/.test(wallet)) throw Error('Invalid binding.');
const kv=mailKv(config); const key=bindingKey(config,wallet,email);
if(action==='revoke') {
  // Version changes invalidate every queued authorization, including a later re-import.
  await kv(['SET',key,JSON.stringify({wallet,email,version:randomBytes(16).toString('hex'),revoked:true}),'PX','2592000000']);
} else {
  const binding={...record,wallet,email,version:randomBytes(16).toString('hex'),revoked:false};
  if(!validMailBinding(binding,wallet,email)) throw Error('A verified-email timestamp, correspondent-specific consent timestamp, evidence ID and future expiry are required.');
  await kv(['SET',key,JSON.stringify(binding),'PX',String(binding.expiresAt-Date.now())]);
}
console.log('Binding updated. No email was sent.');
