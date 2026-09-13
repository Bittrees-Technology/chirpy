// Trusted operator action, not a public recipient-verification endpoint.
import { open } from 'node:fs/promises';
import { mailConfig, suppressMailRecipient } from '../server/mail-service.js';
const [path,...extra]=process.argv.slice(2);
if(!path || extra.length) throw Error('Usage: mail-suppress.mjs private-record.json');
// Suppression remains available while sending is paused; preview stays disabled.
const config=mailConfig({...process.env,CHIRPY_MAIL_ENABLED:'1'});
if(!config) throw Error('Configure mail storage and service credentials.');
const file=await open(path,'r');
let record;
try {
  const data=Buffer.alloc(4097);const {bytesRead}=await file.read(data,0,data.length,0);
  if(bytesRead>4096) throw Error('Record is too large.');
  record=JSON.parse(data.subarray(0,bytesRead).toString());
} finally {await file.close();}
await suppressMailRecipient(config,record);
console.log('Recipient suppressed. No email was sent.');
