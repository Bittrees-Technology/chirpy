// Bounded supervisor job. Startup never provisions/replaces a delivery journal.
import {mailConfig,mailKv,createMailService} from '../server/mail-service.js';
import {createSmtpAdapter,readSmtpSettings} from './mail-smtp-transport.mjs';
async function main(){
  const mode=process.argv[2],cursor=process.argv[3]||null;
  if(!['--once','--status','--profile','--inspect','--review','--reconcile','--review-index','--index'].includes(mode)||process.argv.length>4||cursor&&!['--inspect','--review','--reconcile','--review-index','--index'].includes(mode))throw Error('Invalid command');
  const maintenance=['--inspect','--review','--reconcile','--review-index','--index'].includes(mode);
  if(!maintenance&&mode!=='--profile'&&process.env.CHAT_MAIL_OUTBOUND_WORKER_ENABLED!=='1'){
    if(mode==='--status')process.exitCode=2;
    return {enabled:false,status:'disabled'};
  }
  // Offline profile and explicit maintenance also work while admission/sending is paused.
  const config=mailConfig(mode==='--profile'||maintenance?{...process.env,CHIRPY_MAIL_ENABLED:'1',...(mode==='--profile'?{CHAT_SMTP_PROFILE:'0'.repeat(64)}:{})}:process.env,{deliveryIdentity:!maintenance});
  if(!config||config.provider!=='smtp')throw Error('Private SMTP configuration required');
  if(mode==='--profile')return {profile:(await readSmtpSettings(process.env,config)).profile};
  let adapter;
  try{
    adapter=await createSmtpAdapter(process.env,config);
    if(mode==='--inspect')return adapter.pending({after:cursor});
    const service=createMailService(config,undefined,undefined,adapter);
    if(mode==='--review-index'||mode==='--index')return await service.indexHolds({apply:mode==='--index',cursor:cursor||'0'});
    if(mode==='--review'||mode==='--reconcile')return await service.reconcile({apply:mode==='--reconcile',cursor});
    const result=await (mode==='--status'?service.workerStatus():service.drain());
    // An old hold stays unhealthy through idle ticks and process restarts.
    const health=mode==='--status'?result:await service.workerStatus();
    if(!health.workerHealthy){
      process.exitCode=2;
      if(mode==='--once')await mailKv(config)(['DEL',`${config.prefix}worker:last-success`]);
    }
    return {enabled:true,...result,...(mode==='--once'?{uncertainCount:health.uncertainCount,journalUncertainCount:health.journalUncertainCount,journalStaleUncertainCount:health.journalStaleUncertainCount}:{})};
  }catch(error){
    // A failed scheduled tick must not leave a recent healthy heartbeat behind.
    // Read-only status/inspection and maintenance never change liveness.
    if(mode==='--once')try{await mailKv(config)(['DEL',`${config.prefix}worker:last-success`]);}catch{}
    throw error;
  }finally{adapter?.close();}
}
main().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(()=>{
  process.stderr.write('Outbound worker unavailable. Preserve the queue and SMTP journal; reconcile interrupted submissions before retrying.\n');process.exitCode=1;
});
