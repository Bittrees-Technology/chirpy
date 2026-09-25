// Operator-only bootstrap. Never imported by an HTTP handler or active worker.
import {randomBytes} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {mkdirSync,lstatSync,realpathSync,readdirSync,openSync,writeFileSync,readFileSync,fsyncSync,closeSync,renameSync,constants} from 'node:fs';
import {join,dirname,basename,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {InboundSendJournal} from './inbound-send-journal.js';
import {inboundSenderIdentity} from './inbound-xmtp-sender.js';
import {validInboundSourceConfig} from './inbound-source-process.js';

export function syncPrivateDirectory(path){
 const stat=lstatSync(path);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('Private provisioning directory required');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}
}
export function writePrivateNew(path,value){
 const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
 syncPrivateDirectory(dirname(path));
}
function absent(path){try{lstatSync(path);}catch(error){if(error.code==='ENOENT')return;throw error;}throw Error('Provisioning never overwrites or resumes existing state');}
function requestConfig(request){
 const config=JSON.parse(JSON.stringify(request));
 if(!config||Object.keys(config).length!==4||!['network','directory','identity','source'].every(k=>Object.hasOwn(config,k))||
  !isAbsolute(config.directory)||config.directory!==join(realpathSync(dirname(config.directory)),basename(config.directory)))throw Error('Canonical new sender directory required');
 syncPrivateDirectory(dirname(config.directory));
 const s=config.source;
 if(!validInboundSourceConfig(s))throw Error('Source checker configuration required');
 // Validate network/endpoint before generating or registering an identity.
 inboundSenderIdentity({...config,address:'0x'+'11'.repeat(20),inboxId:'22'.repeat(32),installationId:'33'.repeat(32),databaseKey:'44'.repeat(32)});
 return config;
}
export function runRegistrationProcess(stage,{timeoutMs=60000,script=fileURLToPath(new URL('./inbound-registration-child.js',import.meta.url))}={}){
 if(process.platform==='win32'||process.pid<=1||!isAbsolute(stage)||!isAbsolute(script)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('Invalid registration supervisor');
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[script,'--stage',stage,'--parent-pid',String(process.pid)],{detached:true,shell:false,stdio:['ignore','pipe','pipe'],env:{HOME:process.env.HOME||'',PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  let failed=false,bytes=0,errors=0;const chunks=[];
  const stop=()=>{failed=true;if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}};
  const timer=setTimeout(stop,timeoutMs);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)stop();else chunks.push(chunk);});
  child.stderr.on('data',chunk=>{errors+=chunk.length;if(errors>4096)stop();});
  child.on('error',stop);
  // No database handoff until the native process exits and its pipes close.
  child.on('close',code=>{clearTimeout(timer);if(failed||code!==0){reject(Error('Registration uncertain; preserve staging state'));return;}
   try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(Error('Registration uncertain; preserve staging state'));}
  });
 });
}
export async function provisionInboundSender(request,{register=runRegistrationProcess}={}){
 const config=requestConfig(request),stage=join(dirname(config.directory),'.'+basename(config.directory)+'.provision');
 absent(config.directory);absent(stage);
 // The durable staging directory is the once-only reservation, even after a crash.
 mkdirSync(stage,{mode:0o700});syncPrivateDirectory(dirname(stage));
 const sdkDirectory=join(stage,'sdk');mkdirSync(sdkDirectory,{mode:0o700});
 const registration={network:config.network,databaseKey:randomBytes(32).toString('hex'),privateKey:'0x'+randomBytes(32).toString('hex')};
 const expectedAddress=privateKeyToAccount(registration.privateKey).address.toLowerCase();
 writePrivateNew(join(stage,'registration.json'),registration);
 const receipt=await register(stage);
 if(!receipt||receipt.address!==expectedAddress||Object.keys(receipt).length!==3||!['address','inboxId','installationId'].every(k=>Object.hasOwn(receipt,k)))throw Error('Invalid registration receipt');
 const sender={enabled:false,...config,...receipt,databaseKey:registration.databaseKey};
 const identity=inboundSenderIdentity(sender);
 // Only the fixed database files from our new, now-closed registration process.
 syncPrivateDirectory(sdkDirectory);
 const files=readdirSync(sdkDirectory);
 if(!files.includes('xmtp.db3')||!files.includes('xmtp.db3.sqlcipher_salt')||files.some(name=>!['xmtp.db3','xmtp.db3-wal','xmtp.db3-shm','xmtp.db3.sqlcipher_salt'].includes(name)))throw Error('Unexpected registration database files');
 for(const name of files){
  const path=join(sdkDirectory,name),stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)||stat.size>536870912||(name==='xmtp.db3'&&stat.size===0))throw Error('Unsafe registration database');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{
   if(name==='xmtp.db3.sqlcipher_salt'&&(stat.size!==32||!/^[a-fA-F0-9]{32}$/.test(readFileSync(fd,'utf8'))))throw Error('Invalid registration database salt');
   fsyncSync(fd);
  }finally{closeSync(fd);}
 }
 writePrivateNew(join(stage,'registered.json'),{version:1,...receipt,identity});
 // New-directory journal guard is preserved; never add a blank journal to an SDK directory.
 const journal=InboundSendJournal.provision(config.directory,identity);journal.close();
 // Same-filesystem moves preserve the closed database and its WAL, without making
 // a second runnable installation. A partial move remains disabled and cannot resume.
 for(const name of files)renameSync(join(sdkDirectory,name),join(config.directory,name));
 syncPrivateDirectory(sdkDirectory);syncPrivateDirectory(config.directory);syncPrivateDirectory(dirname(config.directory));
 writePrivateNew(join(stage,'installed.json'),{version:1,directory:config.directory,identity});
 // Configuration is published last, and remains disabled. Wallet signing key is
 // retained only in the registration custody file, never in the sender config.
 writePrivateNew(join(config.directory,'sender.json'),sender);
 return {enabled:false,directory:config.directory,config:join(config.directory,'sender.json'),address:receipt.address,inboxId:receipt.inboxId,installationId:receipt.installationId};
}
