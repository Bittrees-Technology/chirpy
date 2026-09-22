// Install under a supervisor; no timer or service is activated by this entrypoint.
import {fileURLToPath} from 'node:url';
import {inboundMailConfig} from '../server/inbound-mail.js';
import {readInboundSenderConfig} from '../server/inbound-sender-config.js';
import {inboundSenderIdentity} from '../server/inbound-xmtp-sender.js';
import {InboundSendJournal} from '../server/inbound-send-journal.js';
import {runInboundMailJob} from '../server/inbound-queue-worker.js';

async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--once')throw Error('Use --once');
  if(process.env.CHAT_MAIL_INBOUND_WORKER_ENABLED!=='1')return {enabled:false};
  const config=inboundMailConfig();if(!config)throw Error('Inbound configuration unavailable');
  const path=process.env.CHAT_MAIL_SENDER_CONFIG;
  const childConfig=readInboundSenderConfig(path);
  if(childConfig?.enabled!==true)return {enabled:false};
  const journal=new InboundSendJournal(childConfig.directory,inboundSenderIdentity(childConfig));
  try{
    const result=await runInboundMailJob({config,journal,childConfig,processConfig:{
      node:process.execPath,script:fileURLToPath(new URL('../server/inbound-sender-child.js',import.meta.url)),config:path,
    }});
    const blocked=journal.inspect().blocked;
    if(blocked||result.status==='uncertain')process.exitCode=2;
    return {enabled:true,...result,blocked};
  }finally{journal.close();}
}
main().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(()=>{
  process.stderr.write('Inbound worker unavailable. Preserve the journal and retry the same queue state.\n');process.exitCode=1;
});
