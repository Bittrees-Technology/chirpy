// Run only after the operator approves a new dedicated bridge identity/custody.
import {readInboundSenderConfig} from '../server/inbound-sender-config.js';
import {provisionInboundSender} from '../server/inbound-provisioning.js';
async function main(){
 if(process.platform!=='linux'||Number(process.versions.node.split('.')[0])!==24||process.argv.length!==6||process.argv[2]!=='--config'||process.argv[4]!=='--register')throw Error('Use Linux Node 24: --config /private/request.json --register dev|production');
 const config=readInboundSenderConfig(process.argv[3]);
 if(!['dev','production'].includes(process.argv[5])||config.network!==process.argv[5])throw Error('Explicit matching registration network required');
 process.umask(0o077);
 console.log(JSON.stringify(await provisionInboundSender(config)));
}
main().catch(()=>{console.error('Provisioning incomplete. Preserve existing staging/state files; never retry or remove them to reset registration.');process.exitCode=1;});
