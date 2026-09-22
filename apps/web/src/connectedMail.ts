import {stringToHex} from 'viem';
import {parseSiweMessage,createSiweMessage} from 'viem/siwe';
import {getActiveProvider} from './walletProviders';
export type MailConnection={mailbox:string;scopes:('read'|'send')[];expiresAt:string};
export type MailSummary={id:string;from:string;subject:string;date:string};
export type MailMessage=MailSummary&{text:string};
export type MailReceipt={id:string;createdAt:number};
export class MailClientError extends Error {constructor(public code:'session'|'unavailable'|'denied'|'wallet'|'failed'|'storage'|'pageChanged'|'pageLimit',public status?:number){super(code);}}
const isWallet=(v:unknown):v is string=>typeof v==='string'&&/^0x[a-f0-9]{40}$/.test(v);
const messageId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const validMailFolder=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(v)&&v===v.trim();
export async function assertMailWallet(wallet:string){
 const provider=getActiveProvider();if(!provider||!isWallet(wallet))throw new MailClientError('wallet');
 const accounts=await provider.request({method:'eth_accounts'});
 if(!Array.isArray(accounts)||String(accounts[0]).toLowerCase()!==wallet||getActiveProvider()!==provider)throw new MailClientError('wallet');return provider;
}
async function request(action:string,input?:unknown,signal?:AbortSignal){
 const response=await fetch('/api/mail/'+action,{method:input===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(40000)]):AbortSignal.timeout(40000)});
 let data;try{data=await response.json();}catch{throw new MailClientError('failed');}
 if(!response.ok)throw new MailClientError(response.status===401?'session':response.status===403?'denied':response.status===503?'unavailable':'failed',response.status);return data;
}
function connection(v:any):MailConnection|null{
 if(v===null)return null;
 if(!v||typeof v.mailbox!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}@bittrees\.org$/.test(v.mailbox)||!Array.isArray(v.scopes)||!v.scopes.length||v.scopes.length>2||new Set(v.scopes).size!==v.scopes.length||v.scopes.some((s:unknown)=>s!=='read'&&s!=='send')||!Number.isFinite(Date.parse(v.expiresAt)))throw new MailClientError('failed');
 return {mailbox:v.mailbox,scopes:v.scopes,expiresAt:v.expiresAt};
}
export async function mailStatus(wallet:string,signal?:AbortSignal){
 await assertMailWallet(wallet);const data=await request('status?wallet='+encodeURIComponent(wallet),undefined,signal);await assertMailWallet(wallet);
 if(data.wallet!==wallet||data.enabled!==true)throw new MailClientError('wallet');return connection(data.connection);
}
export async function disconnectMail(signal?:AbortSignal){const data=await request('disconnect',{},signal);if(data.ok!==true||typeof data.sourceRevoked!=='boolean')throw new MailClientError('failed');return data.sourceRevoked as boolean;}
export async function connectMail(wallet:string,authenticated:boolean,signal?:AbortSignal){
 const provider=await assertMailWallet(wallet);
 if(!authenticated){
  // Clears an expired or different wallet's browser session before a fresh sign-in.
  await disconnectMail(signal);
  const data=await request('challenge',{wallet},signal),m=typeof data.message==='string'?parseSiweMessage(data.message):{};
  const now=Date.now();
  if(m.address?.toLowerCase()!==wallet||m.domain!=='chat.bittrees.org'||m.uri!=='https://chat.bittrees.org/api/mail/verify'||m.version!=='1'||m.chainId!==1||!/^[a-f0-9]{64}$/.test(m.nonce||'')||!m.issuedAt||!m.expirationTime||m.issuedAt.getTime()>now+30000||m.expirationTime.getTime()<=now||m.expirationTime.getTime()-m.issuedAt.getTime()>300000||m.statement!=='Sign in to connect your mailbox to Chat. Mail will separately ask for read and send permission. No transaction is authorized.')throw new MailClientError('failed');
  if(createSiweMessage({address:m.address!,domain:m.domain!,uri:m.uri!,version:'1',chainId:1,nonce:m.nonce!,issuedAt:m.issuedAt,expirationTime:m.expirationTime,statement:m.statement})!==data.message)throw new MailClientError('failed');
  await assertMailWallet(wallet);if(getActiveProvider()!==provider)throw new MailClientError('wallet');
  signal?.throwIfAborted();
  const signature=await provider.request({method:'personal_sign',params:[stringToHex(data.message),wallet]});
  await assertMailWallet(wallet);signal?.throwIfAborted();
  const signed=await request('verify',{wallet,message:data.message,signature},signal);if(signed.wallet!==wallet)throw new MailClientError('wallet');
 }
 await assertMailWallet(wallet);const data=await request('start',{wallet},signal);await assertMailWallet(wallet);signal?.throwIfAborted();
 let url:URL;try{url=new URL(data.url);}catch{throw new MailClientError('failed');}
 const params=new URLSearchParams(url.hash.slice(1));
 if(url.origin!=='https://mail.bittrees.org'||url.pathname!=='/connect/chat'||url.search||url.username||url.password||params.get('wallet')!==wallet||!/^[a-f0-9]{64}$/.test(params.get('state')||'')||!/^[A-Za-z0-9_-]{43}$/.test(params.get('challenge')||'')||[...params.keys()].length!==3)throw new MailClientError('failed');return url.href;
}
async function operation(wallet:string,action:string,input:unknown,signal?:AbortSignal){await assertMailWallet(wallet);const data=await request('operation',{wallet,action,input},signal);await assertMailWallet(wallet);signal?.throwIfAborted();return data;}
export async function mailFolders(wallet:string,signal?:AbortSignal){const data=await operation(wallet,'folders',{},signal);if(!Array.isArray(data.folders)||data.folders.length>1000||!data.folders.every(validMailFolder))throw new MailClientError('failed');return [...new Set(data.folders)] as string[];}
function summary(v:any):MailSummary{if(!v||!messageId(v.id)||typeof v.from!=='string'||v.from.length>200||typeof v.subject!=='string'||v.subject.length>200||typeof v.date!=='string'||v.date.length>80)throw new MailClientError('failed');return {id:v.id,from:v.from,subject:v.subject,date:v.date};}
export async function mailPage(wallet:string,folder:string,cursor:string|null=null,signal?:AbortSignal){
 if(!validMailFolder(folder)||(cursor!==null&&!messageId(cursor)))throw new MailClientError('failed');
 let data;try{data=await operation(wallet,'messages',{folder,...(cursor?{cursor}:{})},signal);}catch(e){if(e instanceof MailClientError&&(e.status===409||e.status===413))throw new MailClientError(e.status===409?'pageChanged':'pageLimit');throw e;}
 if(!Array.isArray(data.messages)||data.messages.length>25||(data.nextCursor!==undefined&&data.nextCursor!==null&&!messageId(data.nextCursor))||data.nextCursor===cursor&&cursor!==null)throw new MailClientError('failed');
 const messages=data.messages.map(summary) as MailSummary[];
 if(new Set(messages.map(m=>m.id)).size!==messages.length||data.nextCursor&&messages.length!==25)throw new MailClientError('failed');
 return {messages,nextCursor:(data.nextCursor??null) as string|null};
}
export async function mailMessages(wallet:string,folder:string,signal?:AbortSignal){return (await mailPage(wallet,folder,null,signal)).messages;}
export async function mailMessage(wallet:string,folder:string,id:string,signal?:AbortSignal){if(!validMailFolder(folder)||!messageId(id))throw new MailClientError('failed');const data=await operation(wallet,'message',{folder,id},signal),m=summary(data.message);if(m.id!==id||typeof data.message.text!=='string'||new TextEncoder().encode(data.message.text).length>16000)throw new MailClientError('failed');return {...m,text:data.message.text} as MailMessage;}
export type MailDraft={to:string;subject:string;text:string};
export function validMailDraft(d:MailDraft){return d.to.length<=254&&/^[^\s<>@,;\x00-\x1f\x7f]+@[^\s<>@,;\x00-\x1f\x7f]+\.[^\s<>@,;\x00-\x1f\x7f]+$/.test(d.to)&&d.subject.length<=200&&!/[\x00-\x1f\x7f]/.test(d.subject)&&!!d.text.trim()&&!d.text.includes('\0')&&new TextEncoder().encode(JSON.stringify(d)).length<=19000;}
const receiptKey=(wallet:string)=>'chat:mail-pending:v1:'+wallet;
export function mailReceipt(wallet:string):MailReceipt|null{try{const raw=localStorage.getItem(receiptKey(wallet));if(!raw)return null;const r=JSON.parse(raw);if(!messageId(r.id)||!Number.isSafeInteger(r.createdAt)||r.createdAt<=0)throw Error();return {id:r.id,createdAt:r.createdAt};}catch{throw new MailClientError('storage');}}
export function clearMailReceipt(wallet:string){try{localStorage.removeItem(receiptKey(wallet));}catch{throw new MailClientError('storage');}}
export async function sendMail(wallet:string,draft:MailDraft,signal?:AbortSignal){
 if(!validMailDraft(draft))throw new MailClientError('failed');await assertMailWallet(wallet);
 signal?.throwIfAborted();
 if(!navigator.locks)throw new MailClientError('storage');
 const receipt=await navigator.locks.request(receiptKey(wallet),{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)},()=>{
 if(mailReceipt(wallet))throw new MailClientError('storage');
 const receipt={id:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),createdAt:Date.now()};
 try{localStorage.setItem(receiptKey(wallet),JSON.stringify(receipt));}catch{throw new MailClientError('storage');}
 return receipt;
 });
 // Retain this receipt on every uncertain result, including navigation or wallet changes.
 const result=await operation(wallet,'send',{...draft,idempotencyKey:receipt.id},signal);
 if(result.ok!==true)throw new MailClientError('failed');
 await navigator.locks.request(receiptKey(wallet),{},()=>{if(mailReceipt(wallet)?.id===receipt.id)clearMailReceipt(wallet);});
}
export function replyAddress(from:string){const match=/<([^<>]+)>$/.exec(from);const candidate=(match?.[1]||from).trim();return validMailDraft({to:candidate,subject:'',text:'x'})?candidate:'';}
