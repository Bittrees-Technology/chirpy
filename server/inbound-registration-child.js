import {isAbsolute} from 'node:path';
import {registerInboundIdentity} from './inbound-registration.js';
function terminate(){try{process.kill(-process.pid,'SIGKILL');}catch{process.kill(process.pid,'SIGKILL');}}
const parent=Number(process.argv[5]);
if(process.argv.length!==6||process.argv[2]!=='--stage'||process.argv[4]!=='--parent-pid'||!isAbsolute(process.argv[3])||!Number.isSafeInteger(parent)||parent<=1||process.ppid!==parent)terminate();
setTimeout(terminate,55000);
setInterval(()=>{if(process.ppid!==parent)terminate();},250);
process.on('SIGTERM',terminate);process.on('SIGINT',terminate);process.stdout.on('error',terminate);
process.umask(0o077);
registerInboundIdentity(process.argv[3]).then(receipt=>{
 process.stdout.write(JSON.stringify(receipt),()=>process.exit(0));
}).catch(()=>{process.stderr.write('Registration uncertain. Preserve staging files; do not retry.\n',()=>process.exit(1));});
