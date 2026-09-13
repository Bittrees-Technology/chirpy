// One bounded tick. Schedule through an operator-controlled scheduler; no secrets in arguments.
const service=new URL(process.env.CHIRPY_MAIL_SERVICE_URL||'');
if(service.protocol!=='https:' || service.pathname!=='/api/mail' || service.username || service.password || !process.env.CHIRPY_MAIL_WORKER_SECRET) throw Error('Configure mail service and worker secret.');
const response=await fetch(new URL('/api/mail-worker',service),{method:'POST',headers:{Authorization:`Bearer ${process.env.CHIRPY_MAIL_WORKER_SECRET}`},signal:AbortSignal.timeout(60000)});
if(!response.ok) throw Error(`Mail worker failed (${response.status}).`);
console.log(JSON.stringify(await response.json()));
