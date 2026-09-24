// Bounded supervisor job. Startup never provisions/replaces a delivery journal.
import {mailConfig,createMailService} from '../server/mail-service.js';
import {createSmtpAdapter,readSmtpSettings} from './mail-smtp-transport.mjs';
async function main(){
  const mode=process.argv[2];
  if(process.argv.length!==3||!['--once','--status','--profile'].includes(mode))throw Error('Invalid command');
  if(mode!=='--profile'&&process.env.CHAT_MAIL_OUTBOUND_WORKER_ENABLED!=='1'){
    if(mode==='--status')process.exitCode=2;
    return {enabled:false,status:'disabled'};
  }
  const config=mailConfig(mode==='--profile'?{...process.env,CHAT_SMTP_PROFILE:'0'.repeat(64)}:process.env);
  if(!config||config.provider!=='smtp')throw Error('Private SMTP configuration required');
  if(mode==='--profile')return {profile:(await readSmtpSettings(process.env,config)).profile};
  const adapter=await createSmtpAdapter(process.env,config);
  try{
    const service=createMailService(config,undefined,undefined,adapter);
    const result=await (mode==='--status'?service.workerStatus():service.drain());
    if(mode==='--status'&&!result.workerHealthy||result.uncertain>0)process.exitCode=2;
    return {enabled:true,...result};
  }finally{adapter.close();}
}
main().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(()=>{
  process.stderr.write('Outbound worker unavailable. Preserve the queue and SMTP journal; reconcile interrupted submissions before retrying.\n');process.exitCode=1;
});
