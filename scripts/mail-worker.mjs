import {mailWorkerRequest} from '../selfhost/mail-api-scheduler.mjs';
// Manual, explicitly invoked operation; the supervised entry point defaults disabled.
try {
  const action=process.argv[2]||'tick';
  if(process.argv.length>3||!['tick','status'].includes(action))throw Error('Invalid action');
  const result=await mailWorkerRequest(action);
  console.log(JSON.stringify(result));
  if(action==='status'&&!result.workerHealthy)process.exitCode=1;
} catch {
  console.error('Mail worker unavailable. Check configuration and private worker status before retrying.');
  process.exitCode=1;
}
