const action=process.argv[2]||'tick';
if(process.argv.length>3 || !['tick','status'].includes(action)) throw Error('Use mail-worker.mjs [tick|status].');
// One bounded tick. Schedule through an operator-controlled scheduler; no secrets in arguments.
const service=new URL(process.env.CHIRPY_MAIL_SERVICE_URL||'');
if(service.protocol!=='https:' || service.pathname!=='/api/mail' || service.username || service.password || !process.env.CHIRPY_MAIL_WORKER_SECRET) throw Error('Configure mail service and worker secret.');
const response=await fetch(new URL('/api/mail-worker',service),{method:'POST',body:JSON.stringify({action}),headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.CHIRPY_MAIL_WORKER_SECRET}`},signal:AbortSignal.timeout(60000)});
if(!response.ok) throw Error(`Mail worker failed (${response.status}).`);
const result=await response.json();
console.log(JSON.stringify(result));
if(action==='status' && result.workerHealthy!==true) process.exitCode=1;
