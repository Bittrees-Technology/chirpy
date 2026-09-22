import {openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';

export function readInboundSenderConfig(path) {
  if(typeof path!=='string'||!isAbsolute(path))throw Error('Absolute sender configuration required');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o077)||stat.size>16384)throw Error('Private sender configuration required');
    const buffer=Buffer.alloc(16385);let bytes=0;
    while(bytes<buffer.length){const count=readSync(fd,buffer,bytes,buffer.length-bytes,null);if(!count)break;bytes+=count;}
    if(bytes>16384)throw Error('Sender configuration too large');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytes)));
  }finally{closeSync(fd);}
}
