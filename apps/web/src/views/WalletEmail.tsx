import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useIdentity } from '../state';
import { useI18n } from '../i18n';
import { Button, Field } from '../ui';
import { mailEndpoint, submitWalletEmail, type WalletEmailResult } from '../walletEmail';
import { normalizeMailAddress, type MailCommand } from '../../../../packages/core/src/mailAuth.js';
import { getProviderRevision, subscribeProvider } from '../walletProviders';
import { WalletEmailRecovery as WalletEmailRecoveryPanel } from './WalletEmailRecovery';
import {WalletEmailDiscovery} from './WalletEmailDiscovery';
import {readWalletEmailRecovery,reserveWalletEmailReceipt,finishWalletEmailReceipt,walletEmailReceiptKey,walletEmailLegacyReceiptKey,WALLET_EMAIL_RECEIPTS_CHANGED,WalletEmailReceiptError,type WalletEmailRecovery} from '../walletEmailReceipts';

export function WalletEmail() {
  const {identity,mode}=useIdentity();
  const revision=useSyncExternalStore(subscribeProvider,getProviderRevision);
  return <WalletEmailSession key={`${identity.address.toLowerCase()}:${mode}:${revision}`} />;
}

type ReceiptObservation=WalletEmailResult&{checkedAt:number|null;serverUncertain?:boolean};
const observationStatus=(value:ReceiptObservation)=>value.serverUncertain&&!['accepted','stopped'].includes(value.status)?'submissionUncertain':value.status;
function ReceiptDetails({value}:{value:ReceiptObservation}){
 const {t,lang}=useI18n();
 const date=(at:number)=><time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString(lang)}</time>;
 if(value.checkedAt===null)return null;
 return <div className="wallet-email-receipt">
  <p>{t('mail.history.checked')} {date(value.checkedAt)}</p>
  {value.receipt?<dl>
   <dt>{t('mail.history.queued')}</dt><dd>{date(value.receipt.createdAt)}</dd>
   <dt>{t('mail.history.updated')}</dt><dd>{value.receipt.updatedAt===null?t('mail.history.unavailable'):date(value.receipt.updatedAt)}</dd>
   <dt>{t('mail.history.attempts')}</dt><dd>{value.receipt.attempts}</dd>
   <dt>{t('mail.history.retryUntil')}</dt><dd>{date(value.receipt.retryUntil)}</dd>
  </dl>:<p>{t(value.status==='unknown'?'mail.history.unknown':'mail.history.legacy')}</p>}
  {value.status==='accepted'&&<section className="wallet-email-delivery" aria-label={t('mail.delivery.title')}><h4>{t('mail.delivery.title')}</h4><p>{t('mail.delivery.scope')}</p>
   {value.delivery?.events.length?<dl>{value.delivery.events.map(event=><React.Fragment key={event.type}><dt>{t('mail.delivery.'+event.type)}</dt><dd>{date(event.occurredAt)}</dd></React.Fragment>)}</dl>:<p>{t('mail.delivery.empty')}</p>}
  </section>}
 </div>;
}
function WalletEmailSession() {
  const {identity,mode}=useIdentity(); const {t}=useI18n();
  const [enabled,setEnabled]=useState(false),[historyEnabled,setHistoryEnabled]=useState(false);
  const [to,setTo]=useState(''); const [subject,setSubject]=useState(''); const [text,setText]=useState('');
  const [pending,setPending]=useState<MailCommand|null>(null);
  const operation=useRef<AbortController|null>(null);
  useEffect(()=>()=>operation.current?.abort(),[]);
  const wallet=identity.address.toLowerCase();
  const load=()=>readWalletEmailRecovery(wallet,mailEndpoint().service);
  const [recovery,setRecovery]=useState<WalletEmailRecovery|null>(()=>{try{return load();}catch{return null;}});
  const [storageError,setStorageError]=useState(!recovery);
  const [retryExpired,setRetryExpired]=useState(false);
  const [receipt,setReceipt]=useState(recovery?.active??'');
  const selected=useRef(receipt);
  const [status,setStatus]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState(false);
  const [observations,setObservations]=useState<Record<string,ReceiptObservation>>({});
  const remember=(id:string,value:ReceiptObservation)=>setObservations(previous=>Object.fromEntries([...Object.entries(previous).filter(([key])=>key!==id).slice(-99),[id,{...value,serverUncertain:previous[id]?.serverUncertain===true||value.status==='uncertain'&&value.checkedAt!==null}]]));
  const choose=(id:string)=>{selected.current=id;setReceipt(id);setStatus('');setError(false);};
  const refresh=()=>{
    try {
      const state=load();setRecovery(state);setStorageError(false);setRetryExpired(false);
      if(selected.current!==(state.active??'')){choose(state.active??'');setPending(null);}
    }catch{setStorageError(true);}
  };
  useEffect(()=>{
    const changed=(event:Event)=>{
      const key=event instanceof StorageEvent?event.key:(event as CustomEvent<string>).detail;
      try{if(key===null||key===walletEmailLegacyReceiptKey(wallet)||key===walletEmailReceiptKey(wallet,mailEndpoint().service))refresh();}catch{setStorageError(true);}
    };
    window.addEventListener('storage',changed);window.addEventListener(WALLET_EMAIL_RECEIPTS_CHANGED,changed);
    return ()=>{window.removeEventListener('storage',changed);window.removeEventListener(WALLET_EMAIL_RECEIPTS_CHANGED,changed);};
  },[wallet]);
  useEffect(()=>{
    const controller=new AbortController();
    try {const endpoint=mailEndpoint(); void fetch(endpoint.requestUrl,{signal:controller.signal}).then(r=>r.ok?r.json():null).then(data=>{const enabled=data?.enabled===true&&data.service===endpoint.service;setEnabled(enabled);setHistoryEnabled(enabled&&data.historyVersion===1);}).catch(()=>{});}
    catch { /* Native builds without an API origin stay disabled. */ }
    return ()=>controller.abort();
  },[]);
  const valid=!!normalizeMailAddress(to.trim()) && !!subject.trim() && subject.length<=120 && !/[\x00-\x1f\x7f]/.test(subject) && !!text.trim() && new TextEncoder().encode(text).length<=16384;
  const run=async(action:'send'|'status',lookupId?:string)=>{
    if(operation.current || mode!=='wallet') return;
    const controller=new AbortController();operation.current=controller;
    let operationId=lookupId??receipt;setBusy(true);if(!lookupId)setError(false);
    try {
      const base={service:mailEndpoint().service,wallet:identity.address.toLowerCase(),expiresAt:Date.now()+300000};
      let command:MailCommand;
      if(action==='status') command={...base,action,id:lookupId??receipt};
      else {
        command=pending?{...pending,expiresAt:base.expiresAt}:{...base,action,id:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),to:normalizeMailAddress(to.trim())!,subject,text};
        await reserveWalletEmailReceipt(command,!!pending,controller.signal);
        controller.signal.throwIfAborted();
        setPending(command);choose(command.id);setRecovery(load());
      }
      operationId=command.id;remember(command.id,{id:command.id,status:'authorizing',checkedAt:null});if(!lookupId)setStatus('authorizing');
      const result=await submitWalletEmail(command,controller.signal);
      if(!controller.signal.aborted){
        remember(command.id,{...result,checkedAt:Date.now()});
        if(!lookupId&&selected.current===command.id)setStatus(result.status);
      }
    } catch(cause){if(!controller.signal.aborted){
      if(!lookupId&&selected.current===operationId)setError(true);
      if(cause instanceof WalletEmailReceiptError){refresh();setStorageError(true);setRetryExpired(cause.code==='expired');setStatus('');}
      else {remember(operationId,{id:operationId,status:'uncertain',checkedAt:null});if(!lookupId&&selected.current===operationId)setStatus('uncertain');}
    }}
    finally {operation.current=null;if(!controller.signal.aborted)setBusy(false);}
  };
  const startNew=async()=>{
    if(operation.current)return;
    const controller=new AbortController();operation.current=controller;setBusy(true);
    try{
      await finishWalletEmailReceipt(wallet,mailEndpoint().service,receipt,controller.signal);
      controller.signal.throwIfAborted();refresh();setPending(null);choose('');setSubject('');setText('');
    }catch{if(!controller.signal.aborted){refresh();setStorageError(true);}}
    finally{operation.current=null;if(!controller.signal.aborted)setBusy(false);}
  };
  // A failed later lookup must not unlock a server-held submission for resend.
  const terminal=['accepted','stopped','denied','unknown','limited'].includes(status)||observations[receipt]?.serverUncertain===true;
  const visibleStatus=observations[receipt]?.status===status?observationStatus(observations[receipt]):status;
  return <div className="card" data-insights-ignore="true">
    <h2>{t('mail.title')}</h2>
    <p>{t('mail.notice')}</p>
    {!enabled ? <p>{t('mail.disabled')}</p> : <>
      <p>{t('mail.pilot')}</p>
      {mode!=='wallet' && <p>{t('mail.connect')}</p>}
      {storageError&&<div role="alert"><p>{t(retryExpired?'mail.retryExpired':'mail.storageError')}</p><Button disabled={busy} onClick={refresh}>{t('mail.storageRetry')}</Button></div>}
      <Field label={t('routing.recipient')}><input className="input" value={to} disabled={busy||!!pending} onChange={e=>setTo(e.target.value)} /></Field>
      <Field label={t('mail.subject')}><input className="input" maxLength={120} value={subject} disabled={busy||!!pending} onChange={e=>setSubject(e.target.value)} /></Field>
      <Field label={t('mail.message')}><textarea className="input" rows={5} value={text} disabled={busy||!!pending} onChange={e=>setText(e.target.value)} /></Field>
      <Button variant="primary" disabled={busy||storageError||mode!=='wallet'||!valid||terminal||(!pending&&!!receipt)} onClick={()=>void run('send')}>{t(pending?'mail.retry':'mail.send')}</Button>
      <Field label={t('mail.receipt')} hint={t('mail.receiptHint')}><input className="input" value={receipt} disabled={busy||!!pending||!!recovery?.active} onChange={e=>choose(e.target.value)} /></Field>
      <Button disabled={busy||mode!=='wallet'||!/^[a-f0-9]{32}$/.test(receipt)} onClick={()=>void run('status')}>{t('mail.check')}</Button>
      {terminal && <Button disabled={busy||storageError} onClick={()=>void startNew()}>{t('mail.new')}</Button>}
      {status && <p role={error?'alert':'status'}>{t(`mail.status.${visibleStatus}`,t('mail.status.uncertain'))}</p>}
      {status&&observations[receipt]?.status===status&&<ReceiptDetails value={observations[receipt]}/>}
      {!!recovery?.receipts.length&&<details className="wallet-email-history"><summary>{t('mail.savedRequests')}</summary>
        <p>{t('mail.savedRequestsHint')}</p>
        <ul>{recovery.receipts.map(item=><li key={item.id}><code>{item.id}</code>{' '}<Button disabled={busy||mode!=='wallet'} onClick={()=>void run('status',item.id)}>{t('mail.check')}</Button>
          {observations[item.id]&&<><p role={observations[item.id].status==='uncertain'?'alert':'status'}>{t(`mail.status.${observationStatus(observations[item.id])}`,t('mail.status.uncertain'))}</p><ReceiptDetails value={observations[item.id]}/></>}
        </li>)}</ul>
      </details>}
    </>}
    {enabled&&historyEnabled&&mode==='wallet'&&<WalletEmailDiscovery wallet={wallet} service={mailEndpoint().service}/>}
    {mode==='wallet' && (()=>{try{return <WalletEmailRecoveryPanel wallet={wallet} service={mailEndpoint().service}/>;}catch{return null;}})()}
  </div>;
}
