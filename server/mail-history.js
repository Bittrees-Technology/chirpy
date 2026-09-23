import {hash,mailHistoryKey} from './mail-service.js';
import {INDEX_MAIL_HISTORY} from './mail-store.js';
import {parseMailReceiptDetails} from '../packages/core/src/mailAuth.js';

/** One bounded maintenance page. Only the explicit apply mode writes index pointers. */
export async function backfillMailHistory(config,kv,{cursor='0',apply=false}={}){
 if(typeof cursor!=='string'||!/^\d{1,20}$/.test(cursor)||typeof apply!=='boolean')throw Error('Invalid history maintenance options.');
 const prefix=`${config.prefix}job:`;
 const result=await kv(['SCAN',cursor,'MATCH',prefix+'*','COUNT','50']);
 if(!Array.isArray(result)||result.length!==2||typeof result[0]!=='string'||!/^\d{1,20}$/.test(result[0])||!Array.isArray(result[1])||result[1].length>256||result[1].some(key=>typeof key!=='string'||!key.startsWith(prefix)))throw Error('Invalid or oversized history maintenance page.');
 const keys=[...new Set(result[1].filter(key=>/^[a-f0-9]{64}$/.test(key.slice(prefix.length))))];
 let validated=0,indexed=0,missing=0;
 for(const key of keys){
  const raw=await kv(['GET',key]);if(raw===null){missing++;continue;}
  let job;
  try{
   if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)throw Error();job=JSON.parse(raw);
   if(!/^0x[a-f0-9]{40}$/.test(job.wallet)||!/^[a-f0-9]{32}$/.test(job.id)||key!==prefix+hash(`${job.wallet}\n${job.id}`))throw Error();
   parseMailReceiptDetails({version:1,createdAt:job.createdAt,updatedAt:job.updatedAt??null,attempts:job.attempts,retryUntil:job.deadline},job.status);
  }catch{throw Error('Invalid retained mail record. Repair it before completing history maintenance.');}
  validated++;
  if(apply){const changed=await kv(['EVAL',INDEX_MAIL_HISTORY,'2',key,mailHistoryKey(config,job.wallet),job.wallet,job.id,String(job.createdAt)]);if(changed!==0&&changed!==1)throw Error('Invalid history maintenance result.');indexed+=changed;}
 }
 return {cursor:result[0],scanned:keys.length,validated,indexed,missing,complete:result[0]==='0',applied:apply};
}
