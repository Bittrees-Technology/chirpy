import {MAIL_ATTACHMENT_BYTES,MAIL_ATTACHMENT_COUNT,validAttachmentName,validOutgoingAttachments,type OutgoingAttachment} from '../../../packages/core/src/mailAttachments';
export {MAIL_ATTACHMENT_BYTES,MAIL_ATTACHMENT_COUNT,validAttachmentName};
import {stringToHex} from 'viem';
import {parseSiweMessage,createSiweMessage} from 'viem/siwe';
import {getActiveProvider} from './walletProviders';
export type MailConnection={mailbox:string;scopes:('read'|'send')[];expiresAt:string|null};
export type MailSummary={id:string;from:string;subject:string;date:string};
export type MailMessage=MailSummary&{text:string;sourceVersion?:string;replyTo?:string;threadedReply?:boolean};
export type MailReceipt={id:string;createdAt:number};
export class MailClientError extends Error {constructor(public code:'session'|'unavailable'|'denied'|'wallet'|'failed'|'storage'|'pageChanged'|'pageLimit'|'attachmentFiles',public status?:number){super(code);}}
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
 if(!v||typeof v.mailbox!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}@bittrees\.org$/.test(v.mailbox)||!Array.isArray(v.scopes)||!v.scopes.length||v.scopes.length>2||new Set(v.scopes).size!==v.scopes.length||v.scopes.some((s:unknown)=>s!=='read'&&s!=='send')||(v.expiresAt!==null&&(typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt)))))throw new MailClientError('failed');
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
function summary(v:any):MailSummary{if(!v||!messageId(v.id)||typeof v.from!=='string'||Array.from(v.from).length>200||typeof v.subject!=='string'||Array.from(v.subject).length>200||typeof v.date!=='string'||Array.from(v.date).length>80)throw new MailClientError('failed');return {id:v.id,from:v.from,subject:v.subject,date:v.date};}
export async function mailPage(wallet:string,folder:string,cursor:string|null=null,signal?:AbortSignal){
 if(!validMailFolder(folder)||(cursor!==null&&!messageId(cursor)))throw new MailClientError('failed');
 let data;try{data=await operation(wallet,'messages',{folder,...(cursor?{cursor}:{})},signal);}catch(e){if(e instanceof MailClientError&&(e.status===409||e.status===413))throw new MailClientError(e.status===409?'pageChanged':'pageLimit');throw e;}
 if(!Array.isArray(data.messages)||data.messages.length>25||(data.nextCursor!==undefined&&data.nextCursor!==null&&!messageId(data.nextCursor))||data.nextCursor===cursor&&cursor!==null)throw new MailClientError('failed');
 const messages=data.messages.map(summary) as MailSummary[];
 if(new Set(messages.map(m=>m.id)).size!==messages.length||data.nextCursor&&messages.length!==25)throw new MailClientError('failed');
 return {messages,nextCursor:(data.nextCursor??null) as string|null};
}
export type MailThreadMember=MailSummary&{folder:string};
export type MailThreadSummary={id:string;version:string;count:number;latest:MailThreadMember};
export type MailThreadPage={id:string;version:string;count:number;messages:MailThreadMember[];nextCursor:string|null};
function threadMember(value:any):MailThreadMember{if(!validMailFolder(value?.folder))throw new MailClientError('failed');return {...summary(value),folder:value.folder};}
function threadCount(value:unknown):value is number{return Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=10000;}
function pageCursor(data:any,cursor:string|null,count:number){if(data.nextCursor!==null&&!messageId(data.nextCursor)||data.nextCursor!==null&&(data.nextCursor===cursor||count===0))throw new MailClientError('failed');return data.nextCursor as string|null;}
async function conversationOperation(wallet:string,action:string,folder:string,id:string|undefined,cursor:string|null,signal?:AbortSignal){
 if(!validMailFolder(folder)||id!==undefined&&!messageId(id)||cursor!==null&&!messageId(cursor))throw new MailClientError('failed');
 try{return await operation(wallet,action,{folder,...(id?{id}:{}),...(cursor?{cursor}:{})},signal);}catch(e){if(e instanceof MailClientError&&[404,409,413].includes(e.status??0))throw new MailClientError(e.status===413?'pageLimit':'pageChanged');throw e;}
}
export async function mailThreadPage(wallet:string,folder:string,cursor:string|null=null,signal?:AbortSignal){
 const data=await conversationOperation(wallet,'threads',folder,undefined,cursor,signal);
 if(!Array.isArray(data.threads)||data.threads.length>25)throw new MailClientError('failed');
 const threads:MailThreadSummary[]=data.threads.map((v:any)=>{if(!messageId(v?.id)||!messageId(v?.version)||!threadCount(v?.count))throw new MailClientError('failed');return {id:v.id,version:v.version,count:v.count,latest:threadMember(v.latest)};});
 if(new Set(threads.map(t=>t.id)).size!==threads.length)throw new MailClientError('failed');
 return {threads,nextCursor:pageCursor(data,cursor,threads.length)};
}
export async function mailThread(wallet:string,folder:string,id:string,cursor:string|null=null,signal?:AbortSignal):Promise<MailThreadPage>{
 const data=await conversationOperation(wallet,'thread',folder,id,cursor,signal);
 if(data.id!==id||!messageId(data.version)||!threadCount(data.count)||!Array.isArray(data.messages)||!data.messages.length||data.messages.length>25||data.messages.length>data.count)throw new MailClientError('failed');
 const messages=data.messages.map(threadMember) as MailThreadMember[];
 if(new Set(messages.map(m=>m.folder+':'+m.id)).size!==messages.length||cursor===null&&data.nextCursor===null&&messages.length!==data.count||data.nextCursor!==null&&messages.length>=data.count)throw new MailClientError('failed');
 return {id,version:data.version,count:data.count,messages,nextCursor:pageCursor(data,cursor,messages.length)};
}
export async function mailMessages(wallet:string,folder:string,signal?:AbortSignal){return (await mailPage(wallet,folder,null,signal)).messages;}
export async function mailMessage(wallet:string,folder:string,id:string,signal?:AbortSignal){if(!validMailFolder(folder)||!messageId(id))throw new MailClientError('failed');const data=await operation(wallet,'message',{folder,id,transferVersion:2},signal),m=summary(data.message);if(m.id!==id||typeof data.message.text!=='string'||new TextEncoder().encode(data.message.text).length>16000)throw new MailClientError('failed');const v=data.message;if(v.sourceVersion!==undefined&&(!messageId(v.sourceVersion)||typeof v.replyTo!=='string'||v.replyTo!==''&&!validMailDraft({to:v.replyTo,subject:'',text:'x'})||typeof v.threadedReply!=='boolean'))throw new MailClientError('failed');return {...m,text:v.text,...(v.sourceVersion?{sourceVersion:v.sourceVersion,replyTo:v.replyTo,threadedReply:v.threadedReply}:{})} as MailMessage;}
export async function mailHtml(wallet:string,folder:string,id:string,version:string,signal?:AbortSignal){
 if(!validMailFolder(folder)||!messageId(id)||!messageId(version))throw new MailClientError('failed');
 const data=await operation(wallet,'html',{folder,id,version,transferVersion:2},signal);
 if(data.id!==id||data.sourceVersion!==version||typeof data.html!=='string'||new TextEncoder().encode(data.html).length>16000||typeof data.bodyAvailable!=='boolean'||typeof data.truncated!=='boolean'||!data.bodyAvailable&&(data.html!==''||data.truncated))throw new MailClientError('failed');
 return {html:data.html,bodyAvailable:data.bodyAvailable,truncated:data.truncated};
}
export type MailAttachment={id:string;filename:string;contentType:string;bytes:number|null;downloadable:boolean};
const attachmentChunkBytes=12288,attachmentMaxBytes=MAIL_ATTACHMENT_BYTES;
function attachmentItem(value:any):MailAttachment{
 if(!value||typeof value.id!=='string'||value.id.length>64||!/^1(?:\.[1-9][0-9]*){0,7}$/.test(value.id)||typeof value.filename!=='string'||!value.filename||new TextEncoder().encode(value.filename).length>120||/[\x00-\x1f\x7f/\\:<>"|?*\u202a-\u202e\u2066-\u2069]/u.test(value.filename)||value.filename!==value.filename.trim()||value.filename.startsWith('.')||value.filename.endsWith('.')||typeof value.contentType!=='string'||value.contentType.length>100||typeof value.downloadable!=='boolean'||value.bytes!==null&&(!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>2097152)||value.downloadable&&(value.bytes===null||value.bytes>attachmentMaxBytes))throw new MailClientError('failed');
 return {id:value.id,filename:value.filename,contentType:value.contentType,bytes:value.bytes,downloadable:value.downloadable};
}
async function attachmentOperation(wallet:string,folder:string,id:string,version:string,signal?:AbortSignal){
 if(!validMailFolder(folder)||!messageId(id)||!messageId(version))throw new MailClientError('failed');
 const data=await operation(wallet,'attachments',{folder,id,version,transferVersion:2},signal);
 if(data.id!==id||data.sourceVersion!==version||data.chunkBytes!==attachmentChunkBytes||data.transferVersion!==2||data.maxAttachmentBytes!==attachmentMaxBytes)throw new MailClientError('failed');return data;
}
export async function mailAttachments(wallet:string,folder:string,id:string,version:string,signal?:AbortSignal){
 const data=await attachmentOperation(wallet,folder,id,version,signal);
 if(!Array.isArray(data.attachments)||data.attachments.length>20)throw new MailClientError('failed');
 const items=data.attachments.map(attachmentItem) as MailAttachment[];
 if(new Set(items.map(item=>item.id)).size!==items.length)throw new MailClientError('failed');return items;
}
export type MailDownloadProgress={phase:'preparing'|'checking';bytes:number};
export async function downloadMailAttachment(wallet:string,folder:string,id:string,version:string,selection:MailAttachment,signal?:AbortSignal,onProgress?:(progress:MailDownloadProgress)=>void){
 const item=attachmentItem(selection);if(!item.downloadable||item.bytes===null||!validMailFolder(folder)||!messageId(id)||!messageId(version))throw new MailClientError('failed');
 signal?.throwIfAborted();onProgress?.({phase:'preparing',bytes:item.bytes});
 const data=await operation(wallet,'attachmentFile',{folder,id,version,part:item.id,transferVersion:2},signal),returned=attachmentItem(data.attachment);
 if(data.id!==id||data.sourceVersion!==version||data.transfer!=='complete'||data.transferVersion!==2||data.maxAttachmentBytes!==attachmentMaxBytes||JSON.stringify(returned)!==JSON.stringify(item)||!messageId(data.sha256)||typeof data.data!=='string'||data.data.length>4*Math.ceil(attachmentMaxBytes/3))throw new MailClientError('failed');
 let decoded:string;try{decoded=atob(data.data);if(btoa(decoded)!==data.data)throw Error();}catch{throw new MailClientError('failed');}
 if(decoded.length!==item.bytes)throw new MailClientError('failed');
 const bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));signal?.throwIfAborted();onProgress?.({phase:'checking',bytes:item.bytes});
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 await assertMailWallet(wallet);signal?.throwIfAborted();if(digest!==data.sha256)throw new MailClientError('failed');
 // No browser download is created until the entire bounded file is authenticated.
 return {filename:item.filename,bytes};
}
export type MailDraft={to:string;subject:string;text:string;attachments?:OutgoingAttachment[];reply?:{folder:string;id:string;version:string}};
export function validMailDraft(d:MailDraft){
 if(!d||typeof d!=='object'||Object.keys(d).some(k=>!['to','subject','text','reply','attachments'].includes(k))||typeof d.to!=='string'||typeof d.subject!=='string'||typeof d.text!=='string'||d.attachments!==undefined&&!validOutgoingAttachments(d.attachments))return false;
 const {attachments,...text}=d;
 return (!d.reply||validMailFolder(d.reply.folder)&&messageId(d.reply.id)&&messageId(d.reply.version)&&Object.keys(d.reply).length===3)&&d.to.length<=254&&/^[^\s<>@,;\x00-\x1f\x7f]+@[^\s<>@,;\x00-\x1f\x7f]+\.[^\s<>@,;\x00-\x1f\x7f]+$/.test(d.to)&&d.subject.length<=200&&!/[\x00-\x1f\x7f]/.test(d.subject)&&!!d.text.trim()&&!d.text.includes('\0')&&new TextEncoder().encode(JSON.stringify(text)).length<=19000;
}
export async function prepareMailAttachments(files:File[],existing:OutgoingAttachment[]=[],signal?:AbortSignal):Promise<OutgoingAttachment[]>{
 if(!validOutgoingAttachments(existing)||existing.length+files.length>MAIL_ATTACHMENT_COUNT||files.some(f=>!validAttachmentName(f.name)||!Number.isSafeInteger(f.size)||f.size<0||f.size>MAIL_ATTACHMENT_BYTES))throw new MailClientError('attachmentFiles');
 const used=existing.reduce((n,f)=>n+atob(f.content).length,0);
 if(used+files.reduce((n,f)=>n+f.size,0)>MAIL_ATTACHMENT_BYTES)throw new MailClientError('attachmentFiles');
 const added:OutgoingAttachment[]=[];
 for(const file of files){signal?.throwIfAborted();const bytes=new Uint8Array(await file.arrayBuffer());signal?.throwIfAborted();if(bytes.length!==file.size)throw new MailClientError('attachmentFiles');let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));added.push({filename:file.name,content:btoa(binary)});}
 const result=[...existing,...added];if(!validOutgoingAttachments(result))throw new MailClientError('attachmentFiles');return result;
}

const receiptKey=(wallet:string)=>'chat:mail-pending:v1:'+wallet;
export function mailReceipt(wallet:string):MailReceipt|null{try{const raw=localStorage.getItem(receiptKey(wallet));if(!raw)return null;const r=JSON.parse(raw);if(!messageId(r.id)||!Number.isSafeInteger(r.createdAt)||r.createdAt<=0)throw Error();return {id:r.id,createdAt:r.createdAt};}catch{throw new MailClientError('storage');}}
export function clearMailReceipt(wallet:string){try{localStorage.removeItem(receiptKey(wallet));}catch{throw new MailClientError('storage');}}
export async function sendMail(wallet:string,draft:MailDraft,signal?:AbortSignal){
 const snapshot=structuredClone(draft);if(!validMailDraft(snapshot))throw new MailClientError('failed');await assertMailWallet(wallet);
 signal?.throwIfAborted();
 if(!navigator.locks)throw new MailClientError('storage');
 const receipt=await navigator.locks.request(receiptKey(wallet),{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)},()=>{
 if(mailReceipt(wallet))throw new MailClientError('storage');
 const receipt={id:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),createdAt:Date.now()};
 try{localStorage.setItem(receiptKey(wallet),JSON.stringify(receipt));}catch{throw new MailClientError('storage');}
 return receipt;
 });
 // Retain this receipt on every uncertain result, including navigation or wallet changes.
 const result=await operation(wallet,'send',{...snapshot,transferVersion:2,idempotencyKey:receipt.id},signal);
 if(result.ok!==true)throw new MailClientError('failed');
 await navigator.locks.request(receiptKey(wallet),{},()=>{if(mailReceipt(wallet)?.id===receipt.id)clearMailReceipt(wallet);});
}
export function replyAddress(from:string){const match=/<([^<>]+)>$/.exec(from);const candidate=(match?.[1]||from).trim();return validMailDraft({to:candidate,subject:'',text:'x'})?candidate:'';}
