// Run a complete dry-run before apply. This tool never dispatches or requeues mail.
import {mailConfig,mailKv} from '../server/mail-service.js';
import {backfillMailHistory} from '../server/mail-history.js';
const [mode,cursor='0',...extra]=process.argv.slice(2);
if(!['--dry-run','--apply'].includes(mode)||extra.length)throw Error('Usage: mail-history-index.mjs --dry-run|--apply [cursor]');
// Permit maintenance while forwarding is paused; this in-memory override does not change service configuration.
const config=mailConfig({...process.env,CHIRPY_MAIL_ENABLED:'1'},{deliveryIdentity:false});
if(!config)throw Error('Configure the mail service identity and private storage before history maintenance.');
const result=await backfillMailHistory(config,mailKv(config),{cursor,apply:mode==='--apply'});
console.log(JSON.stringify(result));
