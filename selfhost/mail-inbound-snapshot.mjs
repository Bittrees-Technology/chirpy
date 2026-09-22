import {captureInboundSnapshot,verifyInboundSnapshot} from '../server/inbound-snapshot.js';
try{
 if(Number(process.versions.node.split('.')[0])!==24||process.platform!=='linux')throw Error('Use Linux Node 24');
 const [action,path,option,value,...extra]=process.argv.slice(2);
 if(extra.length||!path||!value||!['capture','verify'].includes(action)||option!==(action==='capture'?'--output':'--manifest-sha256'))throw Error('Invalid snapshot command');
 const result=action==='capture'?captureInboundSnapshot(path,value):verifyInboundSnapshot(path,value);
 console.log(JSON.stringify({action,files:result.files,blocked:result.blocked,...(result.manifestSha256?{manifestSha256:result.manifestSha256}:{})}));
}catch{console.error('Snapshot unavailable. Preserve partial copies and any state lock; never reset or activate recovery state automatically.');process.exitCode=1;}
