// One process owns a live sender directory through the complete child lifetime.
// Interrupted ownership is deliberately not expired or reclaimed automatically.
import {randomBytes} from 'node:crypto';
import {mkdirSync,lstatSync,realpathSync,fstatSync,openSync,writeFileSync,readSync,fsyncSync,closeSync,unlinkSync,rmdirSync,constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
export const STATE_LOCK='.operation-lock';
export const RECOVERY_QUARANTINE='recovery-quarantine.json';
function sync(directory){const fd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
export function assertLiveInboundState(directory){
 if(!isAbsolute(directory)||realpathSync(directory)!==directory)throw Error('Canonical sender directory required');
 const stat=lstatSync(directory);if(!stat.isDirectory()||(stat.mode&0o077))throw Error('Private sender directory required');
 try{lstatSync(join(directory,RECOVERY_QUARANTINE));}catch(error){if(error.code==='ENOENT')return;throw error;}
 throw Error('Recovery copy is quarantined; no journal or SDK access is allowed');
}
export function acquireInboundState(directory){
 assertLiveInboundState(directory);
 const path=join(directory,STATE_LOCK),token=randomBytes(32).toString('hex');
 mkdirSync(path,{mode:0o700});sync(directory);
 const owner=join(path,'owner.json'),fd=openSync(owner,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,JSON.stringify({version:1,pid:process.pid,token}));fsyncSync(fd);}finally{closeSync(fd);}
 sync(path);const original=lstatSync(path);let released=false;
 return {release(){
  if(released)return;
  const current=lstatSync(path);
  if(current.isSymbolicLink()||current.dev!==original.dev||current.ino!==original.ino)throw Error('Sender state ownership changed');
  const fd=openSync(owner,constants.O_RDONLY|constants.O_NOFOLLOW);let value;
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.size>1024)throw Error('Invalid state owner');const buffer=Buffer.alloc(1025);let size=0,count;while(size<buffer.length&&(count=readSync(fd,buffer,size,buffer.length-size,null))>0)size+=count;if(size!==stat.size)throw Error('State owner changed');value=JSON.parse(buffer.subarray(0,size).toString('utf8'));}finally{closeSync(fd);}
  if(value.token!==token||value.pid!==process.pid)throw Error('Sender state ownership changed');
  unlinkSync(owner);rmdirSync(path);sync(directory);released=true;
 }};
}
