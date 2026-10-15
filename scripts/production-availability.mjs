import {pathToFileURL} from 'node:url';

// Fixed public endpoints only. Never attach credentials or follow redirects.
export async function checkAvailability(request=fetch) {
  const checks=await Promise.all([
    ['chat','https://chat.bittrees.org/api/health',true],
    ['mail','https://mail.bittrees.org/',false],
  ].map(async ([name,url,json])=>{
    let response;
    try {
      response=await request(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(15000),headers:{Accept:json?'application/json':'text/html'}});
      if(response.status!==200||response.redirected)throw Error();
      if(!json)return {name,available:true};
      if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))throw Error();
      const reader=response.body?.getReader();if(!reader)throw Error();
      let size=0;const parts=[];
      try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384)throw Error();parts.push(value);}}
      finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
      if(!data?.readiness||data.readiness.syncReady!==true||typeof data.readiness.gateReady!=='boolean'||typeof data.readiness.releaseReady!=='boolean')throw Error();
      return {name,available:true,gateReady:data.readiness.gateReady,releaseReady:data.readiness.releaseReady};
    }catch{return {name,available:false};}
    finally {await response?.body?.cancel().catch(()=>{});}
  }));
  return {availabilityPassed:checks.every(c=>c.available),checks,liveDependencyVerificationRequired:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==2){console.error('Use node scripts/production-availability.mjs');process.exitCode=2;}
 else {const report=await checkAvailability();console.log(JSON.stringify(report));process.exitCode=report.availabilityPassed?0:1;}
}
