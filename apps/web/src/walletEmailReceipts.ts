import type {MailCommand} from '../../../packages/core/src/mailAuth.js';

export class WalletEmailReceiptError extends Error {
  constructor(public code:'storage'|'pending'|'limit'|'expired'='storage'){super(code);}
}
export type WalletEmailReceipt={id:string;digest:string|null;createdAt:number|null};
export type WalletEmailRecovery={version:1;active:string|null;receipts:WalletEmailReceipt[]};
export const WALLET_EMAIL_RECEIPTS_CHANGED='chat:wallet-email-receipts-changed';
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{32}$/.test(id);
export const walletEmailLegacyReceiptKey=(wallet:string)=>`chirpy:mail-receipt:${wallet.toLowerCase()}`;
export function walletEmailReceiptKey(wallet:string,service:string){
  if(!/^0x[a-f0-9]{40}$/.test(wallet)||typeof service!=='string'||service.length>2048)throw new WalletEmailReceiptError();
  const url=new URL(service);
  if(!['http:','https:'].includes(url.protocol)||url.href!==service||url.pathname!=='/api/mail'||url.search||url.hash||url.username||url.password)throw new WalletEmailReceiptError();
  return `chat:wallet-email-receipts:v1:${encodeURIComponent(service)}:${wallet}`;
}
export function readWalletEmailRecovery(wallet:string,service:string):WalletEmailRecovery {
  try {
    const raw=localStorage.getItem(walletEmailReceiptKey(wallet,service));
    if(raw!==null&&raw.length>64000)throw Error();
    const state:WalletEmailRecovery=raw===null?{version:1,active:null,receipts:[]}:JSON.parse(raw);
    if(!state||Object.keys(state).sort().join(',')!=='active,receipts,version'||state.version!==1||!Array.isArray(state.receipts)||state.receipts.length>100||!(state.active===null||validId(state.active)))throw Error();
    const ids=new Set<string>();
    for(const receipt of state.receipts){
      if(!receipt||Object.keys(receipt).sort().join(',')!=='createdAt,digest,id'||!validId(receipt.id)||ids.has(receipt.id)||!(receipt.digest===null&&receipt.createdAt===null||typeof receipt.digest==='string'&&/^[a-f0-9]{64}$/.test(receipt.digest)&&typeof receipt.createdAt==='number'&&Number.isSafeInteger(receipt.createdAt)&&receipt.createdAt>0))throw Error();
      ids.add(receipt.id);
    }
    if(state.active!==null&&!ids.has(state.active))throw Error();
    // Read the legacy slot without deleting or overwriting it. Old tabs may still
    // contain a recovery ID; never let a new reservation silently replace it.
    const legacy=localStorage.getItem(walletEmailLegacyReceiptKey(wallet));
    if(legacy!==null&&legacy!==''){
      if(!validId(legacy))throw Error();
      if(!ids.has(legacy)){
        if(state.receipts.length===100)throw new WalletEmailReceiptError('limit');
        state.receipts.push({id:legacy,digest:null,createdAt:null});
        state.active??=legacy;
      }
    }
    return state;
  } catch(error){throw error instanceof WalletEmailReceiptError?error:new WalletEmailReceiptError();}
}
function save(wallet:string,service:string,state:WalletEmailRecovery){
  try {
    const key=walletEmailReceiptKey(wallet,service),raw=JSON.stringify(state);
    localStorage.setItem(key,raw);
    if(localStorage.getItem(key)!==raw)throw Error();
    window.dispatchEvent(new CustomEvent(WALLET_EMAIL_RECEIPTS_CHANGED,{detail:key}));
  } catch {throw new WalletEmailReceiptError();}
}
async function locked<T>(wallet:string,service:string,signal:AbortSignal|undefined,fn:()=>T):Promise<T>{
  if(!navigator.locks)throw new WalletEmailReceiptError();
  const scope=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);
  return navigator.locks.request(walletEmailReceiptKey(wallet,service),{signal:scope},()=>{scope.throwIfAborted();return fn();});
}
export type WalletEmailSnapshot={revision:string;state:WalletEmailRecovery;legacy:string|null};
/** Include both storage slots in the revision. Never repair malformed input during recovery. */
export function snapshotWalletEmailRecovery(wallet:string,service:string):WalletEmailSnapshot {
  try {
    const key=walletEmailReceiptKey(wallet,service),legacyKey=walletEmailLegacyReceiptKey(wallet);
    const raw=localStorage.getItem(key),legacy=localStorage.getItem(legacyKey);
    const state=readWalletEmailRecovery(wallet,service);
    if(localStorage.getItem(key)!==raw||localStorage.getItem(legacyKey)!==legacy)throw Error();
    return {revision:JSON.stringify([raw,legacy]),state,legacy};
  }catch{throw new WalletEmailReceiptError();}
}
/** Recovery changes use the same lock as sends and compare the reviewed/exported revision. */
export async function updateWalletEmailRecovery(wallet:string,service:string,revision:string,
  update:(current:WalletEmailSnapshot)=>WalletEmailRecovery,assertCurrent:()=>void,signal?:AbortSignal){
  return locked(wallet,service,signal,()=>{
    assertCurrent();
    const current=snapshotWalletEmailRecovery(wallet,service);
    if(current.revision!==revision)throw new WalletEmailReceiptError('pending');
    const next=update(current);
    assertCurrent();
    save(wallet,service,next);
  });
}
export async function reserveWalletEmailReceipt(command:MailCommand,retry:boolean,signal?:AbortSignal){
  if(command.action!=='send'||!validId(command.id))throw new WalletEmailReceiptError();
  const bytes=new TextEncoder().encode(JSON.stringify([command.service,command.wallet,command.id,command.to,command.subject,command.text]));
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  return locked(command.wallet,command.service,signal,()=>{
    const state=readWalletEmailRecovery(command.wallet,command.service);
    if(retry){
      const receipt=state.receipts.find(r=>r.id===command.id);
      if(state.active!==command.id||receipt?.digest!==digest)throw new WalletEmailReceiptError('pending');
      if(receipt.createdAt===null||Date.now()<receipt.createdAt||Date.now()-receipt.createdAt>=23*3600000)throw new WalletEmailReceiptError('expired');
    }else{
      if(state.active!==null||state.receipts.some(r=>r.id===command.id))throw new WalletEmailReceiptError('pending');
      if(state.receipts.length===100)throw new WalletEmailReceiptError('limit');
      state.active=command.id;state.receipts.push({id:command.id,digest,createdAt:Date.now()});
    }
    save(command.wallet,command.service,state);
  });
}
export async function finishWalletEmailReceipt(wallet:string,service:string,id:string,signal?:AbortSignal){
  if(!validId(id))throw new WalletEmailReceiptError();
  return locked(wallet,service,signal,()=>{
    const state=readWalletEmailRecovery(wallet,service);
    if(state.active!==null&&state.active!==id)throw new WalletEmailReceiptError('pending');
    // Starting a different message changes only the active selection. Keep all
    // earlier IDs, including ambiguous outcomes, available for signed lookups.
    state.active=null;save(wallet,service,state);
  });
}
