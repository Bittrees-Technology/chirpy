import {pathToFileURL} from 'node:url';

const COUNTS = ['queued','due','oldestDueAgeMs','uncertainCount'];
const integer = value => Number.isSafeInteger(value) && value >= 0;

/** An API scheduler holds only the worker capability, never mailbox/provider keys. */
export async function mailWorkerRequest(action, env=process.env, request=fetch) {
  if(!['tick','status'].includes(action))throw Error('Invalid worker action');
  const service=new URL(env.CHIRPY_MAIL_SERVICE_URL||'');
  const secret=env.CHIRPY_MAIL_WORKER_SECRET;
  if(service.protocol!=='https:'||service.pathname!=='/api/mail'||service.username||service.password||
    service.search||service.hash||service.port||typeof secret!=='string'||secret.length<32||secret.length>512||/[\s\x00-\x1f\x7f]/.test(secret))throw Error('Invalid worker configuration');
  const response=await request(new URL('/api/mail-worker',service),{
    method:'POST',redirect:'error',credentials:'omit',
    body:JSON.stringify({action}),headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},
    signal:AbortSignal.timeout(60000),
  });
  if(response.status!==200||response.redirected||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))throw Error('Worker response rejected');
  const reader=response.body?.getReader();
  if(!reader)throw Error('Missing worker response');
  const chunks=[];let size=0;
  try {
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>8192)throw Error('Worker response too large');chunks.push(value);
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Invalid worker result');
  if(action==='tick'){
    // A public Resend tick claims at most one job. SMTP cannot drain through this route.
    if(!integer(result.processed)||result.processed>1||'uncertain' in result)throw Error('Invalid tick result');
    return {processed:result.processed};
  }
  if(!COUNTS.every(key=>integer(result[key]))||result.due>result.queued||
    !Number.isSafeInteger(result.checkedAt)||result.checkedAt<=0||
    !(result.lastSuccessfulTickAt===null||Number.isSafeInteger(result.lastSuccessfulTickAt)&&result.lastSuccessfulTickAt>0)||
    typeof result.providerBlocked!=='boolean'||typeof result.workerHealthy!=='boolean')throw Error('Invalid worker status');
  const healthy=!result.providerBlocked&&result.uncertainCount===0&&result.lastSuccessfulTickAt!==null&&
    result.lastSuccessfulTickAt<=result.checkedAt&&result.checkedAt-result.lastSuccessfulTickAt<=300000&&result.oldestDueAgeMs<=300000;
  if(result.workerHealthy!==healthy||result.status!==(healthy?'ok':'degraded'))throw Error('Inconsistent worker status');
  return {status:result.status,workerHealthy:healthy,providerBlocked:result.providerBlocked,
    checkedAt:result.checkedAt,lastSuccessfulTickAt:result.lastSuccessfulTickAt,
    ...Object.fromEntries(COUNTS.map(key=>[key,result[key]]))};
}

export async function runMailApiScheduler(args,env=process.env,request=fetch){
  if(args.length!==1||!['--once','--status'].includes(args[0]))throw Error('Invalid scheduler command');
  if(env.CHAT_MAIL_API_SCHEDULER_ENABLED!=='1')return {exitCode:args[0]==='--status'?2:0,result:{enabled:false,status:'disabled'}};
  if(env.CHIRPY_MAIL_PROVIDER!=='resend')throw Error('Resend API scheduler configuration required');
  const tick=args[0]==='--once'?await mailWorkerRequest('tick',env,request):{};
  const health=await mailWorkerRequest('status',env,request);
  return {exitCode:health.workerHealthy?0:2,result:{enabled:true,...tick,...health}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  runMailApiScheduler(process.argv.slice(2)).then(({exitCode,result})=>{
    console.log(JSON.stringify(result));process.exitCode=exitCode;
  }).catch(()=>{
    console.error('Mail API scheduler unavailable. Check service configuration and private worker status before retrying.');process.exitCode=1;
  });
}
