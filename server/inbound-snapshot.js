// Capture/verify a quarantined recovery copy. Never imports or opens the XMTP SDK.
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,realpathSync,lstatSync,fstatSync,readdirSync,openSync,closeSync,readSync,writeSync,readFileSync,fsyncSync,rmSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,isAbsolute,relative} from 'node:path';
import {acquireInboundState,STATE_LOCK,RECOVERY_QUARANTINE} from './inbound-state-lock.js';
import {writePrivateNew,syncPrivateDirectory} from './inbound-provisioning.js';
import {readInboundSenderConfig} from './inbound-sender-config.js';
import {inboundSenderIdentity} from './inbound-xmtp-sender.js';
import {InboundSendJournal} from './inbound-send-journal.js';
export const SNAPSHOT_MANIFEST='snapshot-manifest.json';
const files=['sender.json','send-journal.sqlite','send-journal.sqlite-wal','send-journal.sqlite-shm','xmtp.db3','xmtp.db3-wal','xmtp.db3-shm','xmtp.db3.sqlcipher_salt'];
const required=['sender.json','send-journal.sqlite','xmtp.db3','xmtp.db3.sqlcipher_salt'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const MAX_FILE=512*1024*1024,MAX_TOTAL=2*1024*1024*1024;
function inventory(directory,snapshot=false){
 syncPrivateDirectory(directory);
 const names=readdirSync(directory).filter(name=>snapshot?name!==SNAPSHOT_MANIFEST:name!==STATE_LOCK).sort();
 const allowed=snapshot?[...files,RECOVERY_QUARANTINE]:files;
 if(required.some(name=>!names.includes(name))||snapshot&&!names.includes(RECOVERY_QUARANTINE)||names.some(name=>!allowed.includes(name)))throw Error('Incomplete or unexpected sender state');
 return names;
}
function transfer(directory,name,destination){
 const fd=openSync(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let output;
 try{
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.size>MAX_FILE||(['xmtp.db3','send-journal.sqlite'].includes(name)&&stat.size===0))throw Error('Unsafe snapshot file');
  if(destination)output=openSync(join(destination,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  const digest=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let size=0,count;
  while((count=readSync(fd,buffer,0,buffer.length,null))>0){
   size+=count;if(size>stat.size)throw Error('Sender state changed during snapshot');digest.update(buffer.subarray(0,count));
   if(output!==undefined){let offset=0;while(offset<count)offset+=writeSync(output,buffer,offset,count-offset);}
  }
  const after=fstatSync(fd),entry=lstatSync(join(directory,name));
  if(size!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||entry.ino!==stat.ino||entry.dev!==stat.dev||entry.isSymbolicLink())throw Error('Sender state changed during snapshot');
  if(output!==undefined)fsyncSync(output);
  return {name,size,sha256:digest.digest('hex')};
 }finally{if(output!==undefined)closeSync(output);closeSync(fd);}
}
function fingerprints(directory,names){let total=0;return names.map(name=>{const result=transfer(directory,name);total+=result.size;if(total>MAX_TOTAL)throw Error('Sender state exceeds snapshot limit');return result;});}
function validateJournal(directory,identity){
 // SQLite may recover/checkpoint its own WAL. It only touches this exact private
 // disposable journal copy, never the source, sealed snapshot or messaging DB.
 const root=realpathSync(mkdtempSync(join(tmpdir(),'chat-journal-inspect-')));
 try{
  for(const name of readdirSync(directory).filter(name=>/^send-journal\.sqlite(?:-wal|-shm)?$/.test(name)))transfer(directory,name,root);
  const journal=new InboundSendJournal(root,identity);try{return journal.inspect();}finally{journal.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
}
function configuration(directory){
 const config=readInboundSenderConfig(join(directory,'sender.json'));
 const identity=inboundSenderIdentity(config);
 const saltPath=join(directory,'xmtp.db3.sqlcipher_salt');
 if(lstatSync(saltPath).size!==32)throw Error('Invalid snapshot database salt');
 const salt=readFileSync(saltPath,'utf8');
 if(!/^[a-fA-F0-9]{32}$/.test(salt))throw Error('Invalid snapshot database salt');
 return {config,identity};
}
export function captureInboundSnapshot(source,output){
 if(!isAbsolute(output)||output!==join(realpathSync(dirname(output)),basename(output))||relative(source,output)===''||!relative(source,output).startsWith('..'))throw Error('New canonical snapshot outside the sender directory required');
 syncPrivateDirectory(dirname(output));
 const ownership=acquireInboundState(source);
 try{
  const names=inventory(source),before=fingerprints(source,names),{config,identity}=configuration(source);
  if(config.directory!==source)throw Error('Sender configuration does not match its directory');
  mkdirSync(output,{mode:0o700});syncPrivateDirectory(dirname(output));
  // First persistent content is a quarantine marker; partial copies cannot run.
  writePrivateNew(join(output,RECOVERY_QUARANTINE),{version:1,reason:'Backup only. Fence old sender and review publication evidence before recovery.'});
  for(const name of names)if(name!=='sender.json')transfer(source,name,output);
  writePrivateNew(join(output,'sender.json'),{...config,enabled:false});
  const state=validateJournal(output,identity);
  if(JSON.stringify(before)!==JSON.stringify(fingerprints(source,inventory(source))))throw Error('Sender state changed during snapshot');
  const manifest={version:1,createdAt:Date.now(),source,identity,state,files:fingerprints(output,inventory(output,true))};
  writePrivateNew(join(output,SNAPSHOT_MANIFEST),manifest);
  return {manifestSha256:hash(JSON.stringify(manifest)),files:manifest.files.length,blocked:state.blocked};
 }finally{ownership.release();}
}
export function verifyInboundSnapshot(directory,expectedHash){
 if(!hex(expectedHash))throw Error('Separately trusted snapshot manifest hash required');
 const names=inventory(directory,true),path=join(directory,SNAPSHOT_MANIFEST);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let encoded;
 try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.size>16384)throw Error('Invalid snapshot manifest');const buffer=Buffer.alloc(16385);let size=0,count;while(size<buffer.length&&(count=readSync(fd,buffer,size,buffer.length-size,null))>0)size+=count;if(size!==stat.size)throw Error('Snapshot manifest changed');encoded=buffer.subarray(0,size);}finally{closeSync(fd);}
 if(hash(encoded)!==expectedHash)throw Error('Snapshot manifest does not match trusted recovery record');
 const manifest=JSON.parse(encoded.toString('utf8'));
 if(manifest?.version!==1||!hex(manifest.identity)||!isAbsolute(manifest.source)||!Number.isSafeInteger(manifest.createdAt)||!Array.isArray(manifest.files)||JSON.stringify(manifest.files)!==JSON.stringify(fingerprints(directory,names)))throw Error('Snapshot integrity mismatch');
 const {config,identity}=configuration(directory);
 if(config.enabled!==false||config.directory!==manifest.source||identity!==manifest.identity)throw Error('Snapshot identity or quarantine mismatch');
 const state=validateJournal(directory,identity);
 if(JSON.stringify(state)!==JSON.stringify(manifest.state)||JSON.stringify(manifest.files)!==JSON.stringify(fingerprints(directory,inventory(directory,true))))throw Error('Snapshot journal or files changed');
 return {files:manifest.files.length,blocked:state.blocked,source:manifest.source,identity};
}
