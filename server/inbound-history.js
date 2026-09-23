import {createHmac} from 'node:crypto';
import {recoverMessageAddress} from 'viem';
import {INBOUND_HISTORY_SERVICE,validInboundHistoryCommand,inboundHistorySignMessage,parseInboundHistoryRecord} from '../packages/core/src/inboundHistory.js';
import {LIST_MAIL_HISTORY} from './mail-store.js';
import {mailKv} from './mail-service.js';
// Domain-separated ownership tags reveal neither a mailbox nor a plaintext wallet in storage.
export function inboundHistoryOwner(config,wallet){
 if(typeof wallet!=='string'||!/^0x[a-f0-9]{40}$/.test(wallet))throw Error('Invalid history wallet.');
 return createHmac('sha256',config.key).update(`chat-inbound-history-owner-v1\n${INBOUND_HISTORY_SERVICE}\n${wallet}`).digest('hex');
}
export const inboundHistoryKey=(config,owner)=>`${config.prefix}history:${owner}`;
export async function verifyInboundHistoryCommand(command,signature,now=Date.now()){
 if(!validInboundHistoryCommand(command,now)||typeof signature!=='string'||!/^0x[a-fA-F0-9]{130}$/.test(signature))return false;
 try{return (await recoverMessageAddress({message:inboundHistorySignMessage(command),signature})).toLowerCase()===command.wallet;}catch{return false;}
}
export async function readInboundHistory(config,c,storage=mailKv(config)){
 const owner=inboundHistoryOwner(config,c.wallet),prefix=config.prefix+'job:';
 const result=await storage(['EVAL',LIST_MAIL_HISTORY,'1',inboundHistoryKey(config,owner),String(c.expiresAt),c.cursor?prefix+c.cursor:'']);
 if(!Array.isArray(result)||!result.length)throw Error('Invalid incoming history.');
 const [status,...keys]=result;
 if(['expired','history-changed'].includes(status)&&!keys.length)return {status,id:c.id};
 if(status!=='history'||keys.length>26||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!k.startsWith(prefix)||!/^[a-f0-9]{64}$/.test(k.slice(prefix.length))))throw Error('Invalid incoming history.');
 const page=keys.slice(0,25),rows=page.length?await storage(['MGET',...page]):[];
 if(!Array.isArray(rows)||rows.length!==page.length)throw Error('Invalid incoming history.');
 const records=[];
 for(const raw of rows){
  if(raw===null)continue;
  if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)throw Error('Invalid incoming receipt.');
  const job=JSON.parse(raw);if(job.historyOwner!==owner)throw Error('Invalid incoming history owner.');
  records.push(parseInboundHistoryRecord({id:job.id,status:job.status,createdAt:job.createdAt,updatedAt:job.updatedAt??null,deadline:job.deadline,attempts:job.attempts}));
 }
 if(new Set(records.map(r=>r.id)).size!==records.length)throw Error('Invalid incoming history.');
 return {status:'history',service:INBOUND_HISTORY_SERVICE,wallet:c.wallet,id:c.id,cursor:c.cursor,records,nextCursor:keys.length>25?page.at(-1).slice(prefix.length):null};
}
