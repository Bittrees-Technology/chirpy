// Private self-host process interface; never execute paths supplied by a message.
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createConnection } from 'node:net';
import { validInboundMail,inboundMailScope } from './inbound-mail-contract.js';
const names=['python','script','config','state'];
export function validInboundSourceConfig(config){
 if(config&&Object.keys(config).length===1&&typeof config.socket==='string')return isAbsolute(config.socket)&&Buffer.byteLength(config.socket)<=103&&!/[\x00-\x1f\x7f]/.test(config.socket);
 return config&&Object.keys(config).length===4&&names.every(k=>Object.hasOwn(config,k)&&typeof config[k]==='string'&&config[k].length<=4096&&isAbsolute(config[k])&&!/[\x00-\x1f\x7f]/.test(config[k]));}
const validConfig=validInboundSourceConfig;
export function inboundSourceConfig(env=process.env){
 if(env.CHAT_MAIL_SOURCE_SOCKET){
  if(['CHAT_MAIL_SOURCE_PYTHON','CHAT_MAIL_SOURCE_CHECK_SCRIPT','CHAT_MAIL_SOURCE_CONFIG','CHAT_MAIL_SOURCE_STATE'].some(k=>env[k]))return null;
  const socket={socket:env.CHAT_MAIL_SOURCE_SOCKET};return validConfig(socket)?socket:null;
 }
 const config={python:env.CHAT_MAIL_SOURCE_PYTHON,script:env.CHAT_MAIL_SOURCE_CHECK_SCRIPT,config:env.CHAT_MAIL_SOURCE_CONFIG,state:env.CHAT_MAIL_SOURCE_STATE};
 return validConfig(config)?config:null;
}
export function runSourceCheck(config,input,{timeoutMs=15000}={}){
 if(!validConfig(config)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw Error('Source checker is not configured');
 const raw=JSON.stringify(input);if(Buffer.byteLength(raw)>4096)throw Error('Invalid source scope');
 if(config.socket)return runSourceSocket(config.socket,raw,timeoutMs);
 return new Promise((resolve,reject)=>{
  // Python ignores Python-specific environment and user site packages. Only the
  // installed trusted script directory supplies Mail helper modules.
  const child=spawn(config.python,['-E','-s',config.script,'--config',config.config,'--state',config.state],{shell:false,stdio:['pipe','pipe','pipe'],env:{HOME:process.env.HOME||'',PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  let output=[],bytes=0,errors=0,failed=false;
  const fail=()=>{if(!failed){failed=true;child.kill('SIGKILL');}};
  const timer=setTimeout(fail,timeoutMs);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)fail();else output.push(chunk);});
  child.stderr.on('data',chunk=>{errors+=chunk.length;if(errors>4096)fail();});
  child.stdin.on('error',fail);
  child.on('error',fail);
  child.on('close',code=>{clearTimeout(timer);if(failed||code!==0){reject(Error('Source authority unavailable'));return;}try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(output))));}catch{reject(Error('Invalid source authority response'));}});
  child.stdin.end(raw);
 });
}
function runSourceSocket(path,raw,timeoutMs){
 return new Promise((resolve,reject)=>{
  let chunks=[],bytes=0,settled=false;
  const socket=createConnection({path,allowHalfOpen:true});
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(Error(error)):resolve(result);};
  const timer=setTimeout(()=>finish('Source authority unavailable'),timeoutMs);
  // End the bounded request so the source process can read EOF and reply.
  socket.on('connect',()=>socket.end(raw));
  socket.on('error',()=>finish('Source authority unavailable'));
  socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)finish('Source authority unavailable');else chunks.push(chunk);});
  socket.on('end',()=>{try{finish(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{finish('Invalid source authority response');}});
  socket.on('close',()=>{if(!settled)finish('Source authority unavailable');});
 });
}
export async function checkInboundSource(config,event,run=runSourceCheck){
 if(!validConfig(config))throw Error('Source checker is not configured');
 if(!validInboundMail(event))return false;
 const input={eventId:event.id,contentHash:inboundMailScope(event).contentHash};
 const result=await run(config,input);
 if(!result||typeof result!=='object'||Array.isArray(result)||result.eventId!==input.eventId||result.contentHash!==input.contentHash||typeof result.authorized!=='boolean')throw Error('Invalid source authority response');
 if(result.authorized===false){if(Object.keys(result).length!==3)throw Error('Invalid source authority response');return false;}
 const now=Date.now();
 if(Object.keys(result).length!==5||!Number.isSafeInteger(result.checkedAt)||result.checkedAt<now-5000||result.checkedAt>now+1000||result.sourceDeadline!==event.receivedAt+23*3600000||result.sourceDeadline<=now)throw Error('Stale or invalid source authority response');
 return true;
}
