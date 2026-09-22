// Install under a supervisor; no timer or service is activated by this entrypoint.
import {fileURLToPath} from 'node:url';
import {acquireInboundState} from '../server/inbound-state-lock.js';
import {inboundMailConfig} from '../server/inbound-mail.js';
import {readInboundSenderConfig} from '../server/inbound-sender-config.js';
import {inboundSenderIdentity} from '../server/inbound-xmtp-sender.js';
import {InboundSendJournal} from '../server/inbound-send-journal.js';
import {runInboundMailJob} from '../server/inbound-queue-worker.js';
import {recordInboundWorkerTick,inspectInboundWorker} from '../server/inbound-worker-health.js';

async function main(){
  if(process.argv.length!==3||!['--once','--status'].includes(process.argv[2]))throw Error('Use --once or --status');
  const disabled=()=>{if(process.argv[2]==='--status'){process.exitCode=2;return {enabled:false,status:'disabled'};}return {enabled:false};};
  if(process.env.CHAT_MAIL_INBOUND_WORKER_ENABLED!=='1')return disabled();
  if(process.pid<=1)throw Error('Worker requires a supervisor');
  const config=inboundMailConfig();if(!config)throw Error('Inbound configuration unavailable');
  const path=process.env.CHAT_MAIL_SENDER_CONFIG;
  const childConfig=readInboundSenderConfig(path);
  if(childConfig?.enabled!==true)return disabled();
  if(childConfig.identity?.url!==config.identity.url)throw Error('Inbound worker configuration mismatch');
  const ownership=acquireInboundState(childConfig.directory);
  try{
  const journal=new InboundSendJournal(childConfig.directory,inboundSenderIdentity(childConfig));
  try{
    if(process.argv[2]==='--status'){
      const health=await inspectInboundWorker(config,journal);
      if(health.status!=='healthy')process.exitCode=2;
      return {enabled:true,...health};
    }
    let result;
    try{result=await runInboundMailJob({config,journal,childConfig,processConfig:{
      node:process.execPath,script:fileURLToPath(new URL('../server/inbound-sender-child.js',import.meta.url)),config:path,
    }});}catch(error){
      try{await recordInboundWorkerTick(config,'error',journal.inspect().blocked);}catch{}
      throw error;
    }
    const blocked=journal.inspect().blocked;
    await recordInboundWorkerTick(config,result.status,blocked);
    if(blocked||result.status==='uncertain')process.exitCode=2;
    return {enabled:true,...result,blocked};
  }finally{journal.close();}
  }finally{ownership.release();}
}
main().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(()=>{
  process.stderr.write('Inbound worker unavailable. Preserve the journal, queue state and any operation lock. Reconcile interrupted ownership before retrying.\n');process.exitCode=1;
});
