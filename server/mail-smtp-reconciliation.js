import {createHash} from 'node:crypto';
import {parseMailReceiptDetails} from '../packages/core/src/mailAuth.js';
import {RECONCILE_SMTP_RECEIPT,INDEX_SMTP_HOLD} from './mail-store.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>{throw Error('Invalid SMTP reconciliation state');};

/** One bounded page; no SMTP, identity calls, payload reads or automatic replay. */
export async function reconcileSmtpReceipts({routing,deliveryProvider,smtp,kv},{apply=false,cursor=null,limit=25}={}){
 if(typeof apply!=='boolean'||cursor!==null&&(typeof cursor!=='string'||!/^[a-f0-9]{64}$/.test(cursor))||!Number.isSafeInteger(limit)||limit<1||limit>50)fail();
 const prefix=`${routing.prefix}job:`,index=`${routing.prefix}queue:uncertain`;
 const keys=await kv(['ZRANGEBYLEX',index,cursor?'('+prefix+cursor:'-','+','LIMIT','0',String(limit+1)]);
 if(!Array.isArray(keys)||keys.length>limit+1||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!k.startsWith(prefix)||!/^[a-f0-9]{64}$/.test(k.slice(prefix.length))))fail();
 const result={reviewed:0,eligible:0,reconciled:0,unresolved:0,orphaned:0,conflicts:0,nextCursor:keys.length>limit?keys[limit-1].slice(prefix.length):null,applied:apply};
 for(const key of keys.slice(0,limit)){
  result.reviewed++;
  const raw=await kv(['GET',key]);if(raw===null){result.orphaned++;continue;}
  if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)fail();
  const j=JSON.parse(raw);
  if(!/^0x[a-f0-9]{40}$/.test(j.wallet)||!/^[a-f0-9]{32}$/.test(j.id)||key!==prefix+hash(`${j.wallet}\n${j.id}`))fail();
  parseMailReceiptDetails({version:1,createdAt:j.createdAt,updatedAt:j.updatedAt??null,attempts:j.attempts,retryUntil:j.deadline},j.status);
  if(j.status!=='uncertain'||j.deliveryProvider!==deliveryProvider||!j.smtpReference){result.conflicts++;continue;}
  const requestId=`chirpy-mail/${hash(routing.service)}/${j.wallet}/${j.id}`;
  if(j.smtpReference.requestId!==requestId||j.smtpReference.deadline!==j.deadline)fail();
  const evidence=smtp.recover(j.smtpReference);
  if(['unknown','uncertain'].includes(evidence.status)){result.unresolved++;continue;}
  if(!['accepted','rejected','retryable'].includes(evidence.status)||!/^smtp_[a-f0-9]{32}$/.test(evidence.id)||!Number.isSafeInteger(evidence.attempts)||evidence.attempts<1||evidence.attempts>j.attempts||j.providerId&&j.providerId!==evidence.id)fail();
  result.eligible++;
  if(apply){
   const changed=await kv(['EVAL',RECONCILE_SMTP_RECEIPT,'2',key,index,raw,deliveryProvider,evidence.status,evidence.id,String(evidence.attempts)]);
   if(changed!==0&&changed!==1)fail();
   if(changed)result.reconciled++;else result.conflicts++;
  }
 }
 return result;
}


/** Explicit upgrade repair for retained pre-index holds; never infer an outcome. */
export async function indexSmtpHolds({routing,deliveryProvider,kv},{apply=false,cursor='0'}={}){
 if(typeof apply!=='boolean'||typeof cursor!=='string'||!/^\d{1,20}$/.test(cursor))fail();
 const prefix=`${routing.prefix}job:`,index=`${routing.prefix}queue:uncertain`;
 const page=await kv(['SCAN',cursor,'MATCH',prefix+'*','COUNT','50']);
 if(!Array.isArray(page)||page.length!==2||typeof page[0]!=='string'||!/^\d{1,20}$/.test(page[0])||!Array.isArray(page[1])||page[1].length>256||page[1].some(k=>typeof k!=='string'||!k.startsWith(prefix)))fail();
 const keys=[...new Set(page[1].filter(k=>/^[a-f0-9]{64}$/.test(k.slice(prefix.length))))];
 const result={cursor:page[0],scanned:keys.length,holds:0,indexed:0,foreign:0,complete:page[0]==='0',applied:apply};
 for(const key of keys){
  const raw=await kv(['GET',key]);if(raw===null)continue;
  if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)fail();const j=JSON.parse(raw);
  if(!/^0x[a-f0-9]{40}$/.test(j.wallet)||!/^[a-f0-9]{32}$/.test(j.id)||key!==prefix+hash(`${j.wallet}\n${j.id}`))fail();
  parseMailReceiptDetails({version:1,createdAt:j.createdAt,updatedAt:j.updatedAt??null,attempts:j.attempts,retryUntil:j.deadline},j.status);
  if(j.status!=='uncertain')continue;
  if(j.deliveryProvider!==deliveryProvider){result.foreign++;continue;}
  result.holds++;
  if(apply){const changed=await kv(['EVAL',INDEX_SMTP_HOLD,'2',key,index,raw,deliveryProvider]);if(changed!==0&&changed!==1)fail();result.indexed+=changed;}
 }
 return result;
}
