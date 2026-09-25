import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,readFileSync,writeFileSync,fsyncSync,renameSync,lstatSync,fstatSync,unlinkSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const UNITS=['chat-mail-inbound.service','chat-mail-inbound-health.service','chat-mail-api-scheduler.service'];
const HOUR=3600000,RETRY_WINDOW=23*HOUR;
const hash=value=>createHash('sha256').update(value).digest('hex');
const address=value=>typeof value==='string'&&value.length<=254&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export class AlertReviewRequired extends Error {}
const review=()=>{throw new AlertReviewRequired('Operator alert state needs review');};

export function operatorAlertConfig(env){
 if(env.CHAT_MAIL_ALERTS_ENABLED!=='1')return null;
 let to;try{to=JSON.parse(env.CHAT_MAIL_ALERT_TO||'');}catch{review();}
 const from=env.CHAT_MAIL_ALERT_FROM,key=env.RESEND_API_KEY,state=env.CHAT_MAIL_ALERT_STATE;
 if(!address(from)||!Array.isArray(to)||to.length<1||to.length>4||!to.every(address)||new Set(to.map(x=>x.toLowerCase())).size!==to.length||
 typeof key!=='string'||key.length<16||key.length>512||/[\s\x00-\x1f\x7f]/.test(key)||
 typeof state!=='string'||!isAbsolute(state)||resolve(state)!==state||/[\x00-\x1f\x7f]/.test(state))review();
 return {from,to:[...to].sort(),key,state};
}

function privateFile(info){return info.isFile()&&info.nlink===1&&info.uid===process.getuid()&&(info.mode&0o777)===0o600;}
function directory(path){const s=lstatSync(path);if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)review();}
function readState(path){
 let fd;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if(e.code==='ENOENT')return null;review();}
 try{const s=fstatSync(fd);if(!privateFile(s)||s.size>8192)review();return JSON.parse(readFileSync(fd,'utf8'));}
 catch{review();}finally{closeSync(fd);}
}
function writeState(path,state,parent){
 const temp=join(parent,`.alert-${randomUUID()}.tmp`);let fd;
 try{
  fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  writeFileSync(fd,JSON.stringify(state)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
  renameSync(temp,path);const dir=openSync(parent,constants.O_RDONLY);try{fsyncSync(dir);}finally{closeSync(dir);}
 }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function validState(state,scope,unit,now,count){
 return exact(state,['version','scope','unit','id','createdAt','accepted','payloadHashes'])&&state.version===1&&state.scope===scope&&state.unit===unit&&
 typeof state.id==='string'&&/^[a-f0-9-]{36}$/.test(state.id)&&Number.isSafeInteger(state.createdAt)&&state.createdAt>0&&state.createdAt<=now&&
 Array.isArray(state.accepted)&&state.accepted.length===count&&state.accepted.every(x=>typeof x==='boolean')&&
 Array.isArray(state.payloadHashes)&&state.payloadHashes.length===count&&state.payloadHashes.every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x));
}
export function operatorAlertPayload(config,unit,state,index){
 return {from:config.from,to:[config.to[index]],subject:'Chat delivery service needs attention',
 text:`Chat operator alert\n\nService: ${unit}\nFirst observed: ${new Date(state.createdAt).toISOString()}\nReference: ${state.id}\n\nThe delivery worker or its health check reported a failure. Inspect the private service status on Acer. This alert does not prove that a user message failed or succeeded. Do not resend a user message until its delivery status is reconciled.\n\nThis alert contains no user message, wallet address, mailbox contents or credentials.`};
}
async function acceptedResponse(response){
 if(response.status!==200||response.redirected||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||'')){
  await response.body?.cancel().catch(()=>{});throw Error('Alert provider unavailable');
 }
 const reader=response.body?.getReader();if(!reader)throw Error('Alert provider unavailable');
 let size=0;const parts=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192)throw Error('Alert provider unavailable');parts.push(value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
 if(typeof body?.id!=='string'||!/^[a-f0-9-]{36}$/i.test(body.id))throw Error('Alert provider unavailable');
}

// Production entry uses flock in the system unit. Lock covers the complete read/send/write cycle.
export async function runOperatorAlert(args,env=process.env,{request=fetch,now=Date.now}={}){
 if(args.length!==2||args[0]!=='--failure'||!UNITS.includes(args[1]))review();
 const config=operatorAlertConfig(env);if(!config)return {enabled:false};
 const unit=args[1],at=now();if(!Number.isSafeInteger(at)||at<=0)review();
 directory(config.state);
 const path=join(config.state,unit+'.json'),scope=hash(JSON.stringify([config.from,config.to]));
 let state=readState(path);
 if(state&&!validState(state,scope,unit,at,config.to.length))review();
 if(state&&state.payloadHashes.some((value,i)=>value!==hash(JSON.stringify(operatorAlertPayload(config,unit,state,i)))))review();
 if(state&&state.accepted.every(Boolean)&&at-state.createdAt<HOUR)return {enabled:true,status:'deduplicated'};
 if(!state||state.accepted.every(Boolean)){
  state={version:1,scope,unit,id:randomUUID(),createdAt:at,accepted:config.to.map(()=>false)};
  state.payloadHashes=config.to.map((_,i)=>hash(JSON.stringify(operatorAlertPayload(config,unit,state,i))));
  writeState(path,state,config.state); // Durable reservation before the first provider attempt.
 }
 if(at-state.createdAt>=RETRY_WINDOW)review(); // Never retry after provider deduplication expires.
 let failed=false;
 for(let i=0;i<config.to.length;i++){
  if(state.accepted[i])continue;
  if(now()-state.createdAt>=RETRY_WINDOW)review();
  try{
   const response=await request('https://api.resend.com/emails',{
    method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.key}`,'Idempotency-Key':`chat-alert/${state.id}/${i}`},
    body:JSON.stringify(operatorAlertPayload(config,unit,state,i)),
   });
   await acceptedResponse(response);
  }catch{failed=true;continue;}
  state.accepted[i]=true;writeState(path,state,config.state);
 }
 if(failed)throw Error('Operator alert delivery incomplete');
 return {enabled:true,status:'provider-accepted',recipients:config.to.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 runOperatorAlert(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{
  console.error(error instanceof AlertReviewRequired?'Operator alert configuration or state needs private review.':'Operator alert delivery incomplete; retry only with the existing state.');
  process.exitCode=error instanceof AlertReviewRequired?2:1;
 });
}
