import {formattedMailDocument} from '../mailHtml';
import React,{useEffect,useRef,useState} from 'react';
import {useIdentity} from '../state';
import {useI18n} from '../i18n';
import {Button,Field} from '../ui';
import {MailClientError,mailHtml,mailAttachments,downloadMailAttachment,type MailAttachment,mailStatus,connectMail,disconnectMail,mailFolders,mailPage,mailThreadPage,mailThread,mailMessage,sendMail,mailReceipt,clearMailReceipt,validMailDraft,replyAddress,type MailThreadSummary,type MailThreadPage,type MailConnection,type MailSummary,type MailMessage,type MailDraft,type MailReceipt} from '../connectedMail';
const emptyDraft=():MailDraft=>({to:'',subject:'',text:''});
export function Mailbox({onOpenSettings}:{onOpenSettings:()=>void}){
 const {identity,mode}=useIdentity(),wallet=identity.address.toLowerCase(),{t}=useI18n();
 const canonical=['http:','https:'].includes(window.location.protocol)&&['chat.bittrees.org','localhost','127.0.0.1'].includes(window.location.hostname);
 const [connection,setConnection]=useState<MailConnection|null>(null),[authenticated,setAuthenticated]=useState(false),[phase,setPhase]=useState('checking');
 const [folders,setFolders]=useState<string[]>([]),[folder,setFolder]=useState('INBOX'),[messages,setMessages]=useState<MailSummary[]>([]),[message,setMessage]=useState<MailMessage|null>(null);
 const [composing,setComposing]=useState(false),[draft,setDraft]=useState(emptyDraft),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [receipt,setReceipt]=useState<MailReceipt|null>(null),[receiptBroken,setReceiptBroken]=useState(false),[checkedSent,setCheckedSent]=useState(false);
 const [mailView,setMailView]=useState<'messages'|'conversations'>('messages'),[threads,setThreads]=useState<MailThreadSummary[]>([]);
 const [conversation,setConversation]=useState<(MailThreadPage&{trail:string[]})|null>(null),[messageFolder,setMessageFolder]=useState('INBOX');
 const [htmlPreview,setHtmlPreview]=useState<{key:string;document:string;truncated:boolean}|null>(null);
 const [attachments,setAttachments]=useState<{key:string;items:MailAttachment[]}|null>(null);
 const attachmentKey=message?messageFolder+':'+message.id+':'+message.sourceVersion:'';
 const [cursors,setCursors]=useState<string[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null);
 const epoch=useRef(0),busyRef=useRef(false),pollingRef=useRef(false),controller=useRef<AbortController|null>(null);
 const clearPrivate=()=>{setHtmlPreview(null);setAttachments(null);setThreads([]);setConversation(null);setMessages([]);setMessage(null);setFolders([]);setCursors([]);setNextCursor(null);};
 const readReceipt=()=>{try{setReceipt(mailReceipt(wallet));setReceiptBroken(false);}catch{setReceiptBroken(true);}};
 const cancelPoll=()=>{if(pollingRef.current){epoch.current++;controller.current?.abort();pollingRef.current=false;}};
 const run=async(fn:(signal:AbortSignal,current:()=>boolean)=>Promise<void>,background=false)=>{
  if(busyRef.current||(background&&pollingRef.current))return;
  if(background)pollingRef.current=true;
  else{cancelPoll();busyRef.current=true;setBusy(true);setError('');setNotice('');}
  const generation=++epoch.current,c=new AbortController();controller.current=c;const current=()=>epoch.current===generation&&!c.signal.aborted;
  try{await fn(c.signal,current);}catch(e){if(current()){
   const code=e instanceof MailClientError?e.code:'failed';setError(code);
   if(code==='session'||code==='wallet'||code==='denied'){clearPrivate();setConnection(null);setAuthenticated(false);setPhase(code==='denied'?'denied':'signedOut');}
   if(code==='unavailable'){clearPrivate();setConnection(null);setPhase('unavailable');}
  }}finally{if(epoch.current===generation){controller.current=null;if(background)pollingRef.current=false;else{busyRef.current=false;setBusy(false);readReceipt();}}}
 };
 const load=async(target:string,signal:AbortSignal,current:()=>boolean,trail:string[]=[],view=mailView)=>{
  setMessage(null);setConversation(null);
  if(view==='conversations'){const page=await mailThreadPage(wallet,target,trail.at(-1)??null,signal);if(current()){if(page.nextCursor&&trail.includes(page.nextCursor))throw new MailClientError('pageChanged');setThreads(page.threads);setNextCursor(page.nextCursor);}}
  else{const page=await mailPage(wallet,target,trail.at(-1)??null,signal);if(current()){setMessages(page.messages);setNextCursor(page.nextCursor);}}
  if(current()){setCursors(trail);setFolder(target);setMailView(view);}
 };
 const readMessage=async(sourceFolder:string,id:string,signal:AbortSignal,current:()=>boolean)=>{setHtmlPreview(null);setAttachments(null);setMessage(null);const value=await mailMessage(wallet,sourceFolder,id,signal);if(current()){setMessage(value);setMessageFolder(sourceFolder);}};
 const loadConversation=async(id:string,signal:AbortSignal,current:()=>boolean,trail:string[]=[])=>{
  setMessage(null);const page=await mailThread(wallet,folder,id,trail.at(-1)??null,signal);if(!current())return;
  if(page.nextCursor&&trail.includes(page.nextCursor)||trail.length&&conversation?.version!==page.version)throw new MailClientError('pageChanged');
  setConversation({...page,trail});const first=page.messages[0];if(first)await readMessage(first.folder,first.id,signal,current);
 };
 const refresh=()=>run(async(signal,current)=>{
  clearPrivate();setConnection(null);setPhase('checking');
  const result=await mailStatus(wallet,signal);if(!current())return;setAuthenticated(true);setConnection(result);setPhase('ready');
  if(result?.scopes.includes('read')){const list=await mailFolders(wallet,signal);if(!current())return;setFolders(list);const target=list.includes(folder)?folder:list[0];if(target)await load(target,signal,current);}
 });
 useEffect(()=>{
  readReceipt();if(canonical&&mode==='wallet')void refresh();else setPhase('wallet');
  const storage=(event:StorageEvent)=>{if(event.key==='chat:mail-pending:v1:'+wallet)readReceipt();};window.addEventListener('storage',storage);
  return()=>{epoch.current++;controller.current?.abort();pollingRef.current=false;busyRef.current=false;window.removeEventListener('storage',storage);};
 },[wallet,mode]);
 useEffect(()=>{
  if(!connection||connection.expiresAt===null)return;const expire=()=>{epoch.current++;controller.current?.abort();pollingRef.current=false;busyRef.current=false;setBusy(false);clearPrivate();setConnection(null);setAuthenticated(false);setPhase('signedOut');setError('session');};
  // Browser timers overflow beyond ~24 days. Recheck fixed expiries in bounded steps.
  const deadline=Date.parse(connection.expiresAt);let timer:ReturnType<typeof setTimeout>;
  const check=()=>{const remaining=deadline-Date.now();if(remaining<=0)expire();else timer=setTimeout(check,Math.min(remaining,86400000));};
  check();return()=>clearTimeout(timer);
 },[connection]);
 const pending=!!receipt||receiptBroken,canRead=!!connection?.scopes.includes('read'),canSend=!!connection?.scopes.includes('send');
 // Poll without locking controls. Foreground actions invalidate/abort polls; late results cannot replace a newer view.
 useEffect(()=>{
  if(!canRead||composing||cursors.length)return;
  const timer=setInterval(()=>{if(document.visibilityState!=='visible'||busyRef.current)return;
   void run(async(signal,current)=>{
    if(mailView==='conversations'){const page=await mailThreadPage(wallet,folder,null,signal);if(current()){setThreads(page.threads);setNextCursor(page.nextCursor);if(conversation&&!page.threads.some(t=>t.id===conversation.id&&t.version===conversation.version)){setConversation(null);setMessage(null);setNotice('conversationChanged');}}}
    else{const page=await mailPage(wallet,folder,null,signal);if(current()){setMessages(page.messages);setNextCursor(page.nextCursor);if(message&&!page.messages.some(m=>m.id===message.id))setMessage(null);}}
   },true);
  },45000);
  return()=>{clearInterval(timer);cancelPoll();};
 },[canRead,composing,wallet,folder,message,cursors.length,mailView,conversation]);
 const selectMessage=(id:string)=>void run(async(signal,current)=>{setMessage(null);setComposing(false);await readMessage(folder,id,signal,current);});
 const compose=()=>{cancelPoll();setConversation(null);setDraft(emptyDraft());setMessage(null);setComposing(true);};
 const reply=()=>{if(!message)return;cancelPoll();setDraft({to:message.replyTo??replyAddress(message.from),subject:(/^re:/i.test(message.subject)?message.subject:'Re: '+message.subject).slice(0,200),text:'',...(message.sourceVersion?{reply:{folder:messageFolder,id:message.id,version:message.sourceVersion}}:{})});setMessage(null);setComposing(true);};
 return <section className="mailbox" aria-label={t('mailbox.title')}>
  <header className="mailbox-header"><div><h1>{t('mailbox.title')}</h1><p>{connection?.mailbox||t('mailbox.intro')}</p></div><div className="mailbox-actions">
   {canonical&&mode==='wallet'&&<Button disabled={busy} onClick={()=>void refresh()}>{t('mailbox.refresh')}</Button>}
   {connection&&<><Button disabled={busy||!canSend||pending} onClick={compose}>{t('mailbox.compose')}</Button><Button disabled={busy} onClick={()=>void run(async(signal,current)=>{const revoked=await disconnectMail(signal);if(current()){clearPrivate();setDraft(emptyDraft());setComposing(false);setConnection(null);setAuthenticated(false);setPhase('signedOut');setNotice(revoked?'disconnected':'revokeSource');}})}>{t('mailbox.disconnect')}</Button></>}
  </div></header>
  <p className="mailbox-notice">{t('mailbox.privacy')}</p>
  {error&&<p className="mailbox-alert" role="alert">{t('mailbox.error.'+error)}</p>}
  {notice&&<p className="mailbox-notice" role="status">{t('mailbox.'+notice)}{notice==='revokeSource'&&<> <a href="https://mail.bittrees.org/connect/chat" target="_blank" rel="noreferrer">{t('mailbox.openMail')}</a></>}</p>}
  {busy&&<p className="mailbox-notice" role="status">{t('mailbox.working')} <Button onClick={()=>{epoch.current++;controller.current?.abort();pollingRef.current=false;busyRef.current=false;setBusy(false);setNotice('cancelled');readReceipt();}}>{t('mailbox.cancel')}</Button></p>}
  {pending&&<div className="mailbox-pending" role="status"><strong>{t('mailbox.pending')}</strong><p>{t('mailbox.pendingHint')}</p>
   {canRead&&<Button disabled={busy} onClick={()=>void run(async(signal,current)=>{setComposing(false);await load('Sent',signal,current);})}>{t('mailbox.checkSent')}</Button>}
   <label><input type="checkbox" checked={checkedSent} onChange={e=>setCheckedSent(e.target.checked)}/>{t('mailbox.checkedSent')}</label>
   <Button disabled={busy||!checkedSent} onClick={()=>{try{clearMailReceipt(wallet);setReceipt(null);setReceiptBroken(false);setCheckedSent(false);setDraft(emptyDraft());setNotice('newDraft');}catch{setError('storage');}}}>{t('mailbox.clearPending')}</Button>
  </div>}
  {!canonical?<div className="mailbox-empty"><h2>{t('mailbox.canonicalTitle')}</h2><p>{t('mailbox.canonicalHint')}</p><a className="btn btn-primary" href="https://chat.bittrees.org/?mail=connected">{t('mailbox.openChat')}</a></div>:mode!=='wallet'?<div className="mailbox-empty"><h2>{t('mailbox.walletTitle')}</h2><p>{t('mailbox.walletHint')}</p><Button onClick={onOpenSettings}>{t('mailbox.settings')}</Button></div>:!connection&&!busy?<div className="mailbox-empty">
   <h2>{t(phase==='denied'?'mailbox.deniedTitle':phase==='unavailable'?'mailbox.unavailable':'mailbox.connectTitle')}</h2><p>{t(phase==='denied'?'mailbox.deniedHint':phase==='unavailable'?'mailbox.unavailableHint':'mailbox.connectHint')}</p>
   {phase!=='unavailable'&&phase!=='denied'&&<Button variant="primary" onClick={()=>void run(async(signal,current)=>{const url=await connectMail(wallet,authenticated,signal);if(current())window.location.assign(url);})}>{t('mailbox.connect')}</Button>}
   {(authenticated||phase==='denied')&&<Button onClick={()=>void run(async(signal,current)=>{await disconnectMail(signal);if(current()){setAuthenticated(false);setPhase('signedOut');}})}>{t('mailbox.resetConnection')}</Button>}
  </div>:connection?<div className="mailbox-content">
   {canRead?<aside className="mailbox-list"><Field label={t('mailbox.folder')}><select className="input" value={folder} disabled={busy} onChange={e=>{const target=e.target.value;void run(async(signal,current)=>{setComposing(false);await load(target,signal,current);});}}>{folders.map(f=><option key={f} value={f}>{t('mailbox.folder.'+f,f)}</option>)}</select></Field>
    <Field label={t('mailbox.view')}><select className="input" value={mailView} disabled={busy} onChange={e=>{const view=e.target.value as 'messages'|'conversations';void run(async(signal,current)=>{setComposing(false);await load(folder,signal,current,[],view);});}}><option value="messages">{t('mailbox.individual')}</option><option value="conversations">{t('mailbox.conversations')}</option></select></Field>
    {mailView==='conversations'&&<p className="mailbox-list-hint">{t('mailbox.conversationScope')}</p>}
    <p className="mailbox-list-hint">{t(mailView==='conversations'?(cursors.length?'mailbox.olderConversationsHint':'mailbox.recentConversations'):(cursors.length?'mailbox.olderHint':'mailbox.recent'))}</p>
    <div className="mailbox-actions">{cursors.length>0&&<Button disabled={busy} onClick={()=>void run(async(signal,current)=>{setComposing(false);await load(folder,signal,current,cursors.slice(0,-1));})}>{t(mailView==='conversations'?'mailbox.newerConversations':'mailbox.newer')}</Button>}{nextCursor&&<Button disabled={busy} onClick={()=>void run(async(signal,current)=>{setComposing(false);await load(folder,signal,current,[...cursors,nextCursor]);})}>{t(mailView==='conversations'?'mailbox.olderConversations':'mailbox.older')}</Button>}</div>
    <div className="mailbox-rows">{!(mailView==='conversations'?threads:messages).length&&!busy&&<p>{t('mailbox.empty')}</p>}
    {mailView==='conversations'?threads.map(thread=><button className={'mailbox-row'+(conversation?.id===thread.id?' selected':'')} disabled={busy} key={thread.id} onClick={()=>void run(async(signal,current)=>{setComposing(false);await loadConversation(thread.id,signal,current);})}><strong>{thread.latest.subject||t('mailbox.noSubject')}</strong><span>{thread.latest.from}</span><time>{thread.latest.date}</time><span>{t('mailbox.conversationCount',undefined,{count:String(thread.count)})}</span></button>):messages.map(m=><button className={'mailbox-row'+(message?.id===m.id?' selected':'')} disabled={busy} key={m.id} onClick={()=>selectMessage(m.id)}><strong>{m.subject||t('mailbox.noSubject')}</strong><span>{m.from}</span><time>{m.date}</time></button>)}
    </div>
   </aside>:<aside className="mailbox-list"><p>{t('mailbox.sendOnly')}</p></aside>}
   <div className="mailbox-detail">
    {conversation&&!composing&&<section className="mailbox-conversation" aria-label={t('mailbox.conversationMessages')}><h2>{t('mailbox.conversationMessages')}</h2><p>{t('mailbox.conversationCount',undefined,{count:String(conversation.count)})} · {t('mailbox.newestFirst')}</p><div className="mailbox-actions">{conversation.trail.length>0&&<Button disabled={busy} onClick={()=>void run((signal,current)=>loadConversation(conversation.id,signal,current,conversation.trail.slice(0,-1)))}>{t('mailbox.newer')}</Button>}{conversation.nextCursor&&<Button disabled={busy} onClick={()=>void run((signal,current)=>loadConversation(conversation.id,signal,current,[...conversation.trail,conversation.nextCursor!]))}>{t('mailbox.older')}</Button>}</div><div className="mailbox-conversation-members">{conversation.messages.map(m=><button className={'mailbox-row'+(message?.id===m.id&&messageFolder===m.folder?' selected':'')} key={m.folder+':'+m.id} disabled={busy} onClick={()=>void run((signal,current)=>readMessage(m.folder,m.id,signal,current))}><strong>{m.subject||t('mailbox.noSubject')}</strong><span>{m.from} · {t('mailbox.folder.'+m.folder,m.folder)}</span><time>{m.date}</time></button>)}</div></section>}
    {composing?<form onSubmit={e=>{e.preventDefault();if(busy||pending||!canSend||!validMailDraft(draft))return;void run(async(signal,current)=>{try{await sendMail(wallet,draft,signal);if(current()){setDraft(emptyDraft());setComposing(false);setNotice('sent');if(canRead)await load('Sent',signal,current);}}finally{if(current())readReceipt();}});}}>
     <h2>{t(draft.reply?'mailbox.reply':'mailbox.compose')}</h2><p>{t('mailbox.from',undefined,{mailbox:connection.mailbox})}</p>
     <Field label={t('mailbox.to')}><input className="input" type="email" value={draft.to} maxLength={254} required disabled={busy||pending} onChange={e=>setDraft({...draft,to:e.target.value})}/></Field>
     <Field label={t('mailbox.subject')}><input className="input" value={draft.subject} maxLength={200} disabled={busy||pending} onChange={e=>setDraft({...draft,subject:e.target.value})}/></Field>
     <Field label={t('mailbox.message')}><textarea className="input" rows={12} value={draft.text} required disabled={busy||pending} onChange={e=>setDraft({...draft,text:e.target.value})}/></Field>
     <p>{t('mailbox.draftHint')}</p><Button type="submit" variant="primary" disabled={busy||pending||!canSend||!validMailDraft(draft)}>{t('mailbox.send')}</Button>
    </form>:message?<article><h2>{message.subject||t('mailbox.noSubject')}</h2><p>{message.from}</p><time>{message.date}</time><p className="mailbox-notice">{t('mailbox.previewLimit')} <a href="https://mail.bittrees.org/" target="_blank" rel="noreferrer">{t('mailbox.openMailbox')}</a></p>{message.sourceVersion&&<div className="mailbox-actions">{htmlPreview?.key===attachmentKey?<Button disabled={busy} onClick={()=>setHtmlPreview(null)}>{t('mailbox.plainView')}</Button>:<Button disabled={busy||!canRead} onClick={()=>void run(async(signal,current)=>{const value=await mailHtml(wallet,messageFolder,message.id,message.sourceVersion!,signal);if(!current())return;if(!value.bodyAvailable){setNotice('noFormattedBody');return;}const document=formattedMailDocument(value.html);if(current())setHtmlPreview({key:attachmentKey,document,truncated:value.truncated});})}>{t('mailbox.formattedView')}</Button>}</div>}{htmlPreview?.key===attachmentKey?<><p className="mailbox-notice">{t('mailbox.formattedHint')}{htmlPreview.truncated?' '+t('mailbox.formattedShortened'):''}</p><iframe className="mailbox-html" title={t('mailbox.formattedTitle')} sandbox="" referrerPolicy="no-referrer" srcDoc={htmlPreview.document}/></>:<pre className="mailbox-body">{message.text}</pre>}{message.sourceVersion&&<section className="mailbox-attachments" aria-label={t('mailbox.attachments')}><h3>{t('mailbox.attachments')}</h3><p className="mailbox-notice">{t('mailbox.attachmentHint')}</p>{attachments?.key!==attachmentKey?<Button disabled={busy||!canRead} onClick={()=>void run(async(signal,current)=>{const items=await mailAttachments(wallet,messageFolder,message.id,message.sourceVersion!,signal);if(current())setAttachments({key:attachmentKey,items});})}>{t('mailbox.showAttachments')}</Button>:attachments.items.length?<ul>{attachments.items.map(item=><li key={item.id}><span>{item.filename}{item.bytes!==null?' · '+item.bytes+' B':''}</span> {item.downloadable?<Button disabled={busy||!canRead} onClick={()=>void run(async(signal,current)=>{const result=await downloadMailAttachment(wallet,messageFolder,message.id,message.sourceVersion!,item,signal);if(!current())return;const url=URL.createObjectURL(new Blob([result.bytes],{type:'application/octet-stream'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=result.filename;document.body.append(anchor);try{anchor.click();setNotice('downloadReady');}finally{anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}})}>{t('mailbox.download')}</Button>:<span>{t('mailbox.attachmentUnsupported')}</span>}</li>)}</ul>:<p>{t('mailbox.noAttachments')}</p>}</section>}{message.sourceVersion&&!message.threadedReply&&<p className="mailbox-notice">{t('mailbox.unthreadedReply')}</p>}<Button disabled={busy||!canSend||pending||!(message.replyTo??replyAddress(message.from))} onClick={reply}>{t('mailbox.reply')}</Button></article>:<div className="mailbox-empty"><h2>{t('mailbox.select')}</h2><p>{t(canRead?'mailbox.selectHint':'mailbox.sendOnly')}</p></div>}
   </div>
  </div>:null}
 </section>;
}
