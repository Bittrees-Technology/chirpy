import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useIdentity } from '../state';
import { useI18n } from '../i18n';
import { Button, Field } from '../ui';
import { mailEndpoint, submitWalletEmail } from '../walletEmail';
import { normalizeMailAddress, type MailCommand } from '../../../../packages/core/src/mailAuth.js';
import { getProviderRevision, subscribeProvider } from '../walletProviders';
import {readWalletEmailRecovery,reserveWalletEmailReceipt,finishWalletEmailReceipt,walletEmailReceiptKey,walletEmailLegacyReceiptKey,WALLET_EMAIL_RECEIPTS_CHANGED,WalletEmailReceiptError,type WalletEmailRecovery} from '../walletEmailReceipts';

export function WalletEmail() {
  const {identity,mode}=useIdentity();
  const revision=useSyncExternalStore(subscribeProvider,getProviderRevision);
  return <WalletEmailSession key={`${identity.address.toLowerCase()}:${mode}:${revision}`} />;
}

function WalletEmailSession() {
  const {identity,mode}=useIdentity(); const {t}=useI18n();
  const [enabled,setEnabled]=useState(false);
  const [to,setTo]=useState(''); const [subject,setSubject]=useState(''); const [text,setText]=useState('');
  const [pending,setPending]=useState<MailCommand|null>(null);
  const operation=useRef<AbortController|null>(null);
  useEffect(()=>()=>operation.current?.abort(),[]);
  const wallet=identity.address.toLowerCase();
  const load=()=>readWalletEmailRecovery(wallet,mailEndpoint().service);
  const [recovery,setRecovery]=useState<WalletEmailRecovery|null>(()=>{try{return load();}catch{return null;}});
  const [storageError,setStorageError]=useState(!recovery);
  const [receipt,setReceipt]=useState(recovery?.active??'');
  const selected=useRef(receipt);
  const [status,setStatus]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState(false);
  const [historyStatus,setHistoryStatus]=useState<{id:string;status:string}|null>(null);
  const choose=(id:string)=>{selected.current=id;setReceipt(id);setStatus('');setError(false);};
  const refresh=()=>{
    try {
      const state=load();setRecovery(state);setStorageError(false);
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
    try {const endpoint=mailEndpoint(); void fetch(endpoint.requestUrl,{signal:controller.signal}).then(r=>r.ok?r.json():null).then(data=>setEnabled(data?.enabled===true && data.service===endpoint.service)).catch(()=>{});}
    catch { /* Native builds without an API origin stay disabled. */ }
    return ()=>controller.abort();
  },[]);
  const valid=!!normalizeMailAddress(to.trim()) && !!subject.trim() && subject.length<=120 && !/[\x00-\x1f\x7f]/.test(subject) && !!text.trim() && new TextEncoder().encode(text).length<=16384;
  const run=async(action:'send'|'status',lookupId?:string)=>{
    if(operation.current || mode!=='wallet') return;
    const controller=new AbortController();operation.current=controller;
    setBusy(true);setError(false);
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
      if(lookupId)setHistoryStatus({id:lookupId,status:'authorizing'});else setStatus('authorizing');
      const result=await submitWalletEmail(command,controller.signal);
      if(!controller.signal.aborted){
        if(lookupId)setHistoryStatus({id:lookupId,status:result.status});
        else if(selected.current===command.id)setStatus(result.status);
      }
    } catch(cause){if(!controller.signal.aborted){
      setError(true);
      if(cause instanceof WalletEmailReceiptError){refresh();setStorageError(true);setStatus('');}
      else if(lookupId)setHistoryStatus({id:lookupId,status:'uncertain'});
      else setStatus('uncertain');
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
  const terminal=['accepted','stopped','denied','unknown','limited'].includes(status);
  return <div className="card">
    <h2>{t('mail.title')}</h2>
    <p>{t('mail.notice')}</p>
    {!enabled ? <p>{t('mail.disabled')}</p> : <>
      <p>{t('mail.pilot')}</p>
      {mode!=='wallet' && <p>{t('mail.connect')}</p>}
      {storageError&&<div role="alert"><p>{t('mail.storageError')}</p><Button disabled={busy} onClick={refresh}>{t('mail.storageRetry')}</Button></div>}
      <Field label={t('routing.recipient')}><input className="input" value={to} disabled={busy||!!pending} onChange={e=>setTo(e.target.value)} /></Field>
      <Field label={t('mail.subject')}><input className="input" maxLength={120} value={subject} disabled={busy||!!pending} onChange={e=>setSubject(e.target.value)} /></Field>
      <Field label={t('mail.message')}><textarea className="input" rows={5} value={text} disabled={busy||!!pending} onChange={e=>setText(e.target.value)} /></Field>
      <Button variant="primary" disabled={busy||storageError||mode!=='wallet'||!valid||terminal||(!pending&&!!receipt)} onClick={()=>void run('send')}>{t(pending?'mail.retry':'mail.send')}</Button>
      <Field label={t('mail.receipt')} hint={t('mail.receiptHint')}><input className="input" value={receipt} disabled={busy||!!pending||!!recovery?.active} onChange={e=>choose(e.target.value)} /></Field>
      <Button disabled={busy||mode!=='wallet'||!/^[a-f0-9]{32}$/.test(receipt)} onClick={()=>void run('status')}>{t('mail.check')}</Button>
      {terminal && <Button disabled={busy||storageError} onClick={()=>void startNew()}>{t('mail.new')}</Button>}
      {status && <p role={error?'alert':'status'}>{t(`mail.status.${status}`,t('mail.status.uncertain'))}</p>}
      {!!recovery?.receipts.length&&<details><summary>{t('mail.savedRequests')}</summary>
        <p>{t('mail.savedRequestsHint')}</p>
        <ul>{recovery.receipts.map(item=><li key={item.id}><code>{item.id}</code>{' '}<Button disabled={busy||mode!=='wallet'} onClick={()=>void run('status',item.id)}>{t('mail.check')}</Button>
          {historyStatus?.id===item.id&&<p role="status">{t(`mail.status.${historyStatus.status}`,t('mail.status.uncertain'))}</p>}
        </li>)}</ul>
      </details>}
    </>}
  </div>;
}
