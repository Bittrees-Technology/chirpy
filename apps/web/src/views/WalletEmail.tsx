import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useIdentity } from '../state';
import { useI18n } from '../i18n';
import { Button, Field } from '../ui';
import { mailEndpoint, submitWalletEmail } from '../walletEmail';
import { normalizeMailAddress, type MailCommand } from '../../../../packages/core/src/mailAuth.js';
import { getProviderRevision, subscribeProvider } from '../walletProviders';

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
  const receiptKey=`chirpy:mail-receipt:${identity.address.toLowerCase()}`;
  const [receipt,setReceipt]=useState(()=>{try{return localStorage.getItem(receiptKey)||'';}catch{return '';}}); const [status,setStatus]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState(false);
  useEffect(()=>{try{if(receipt)localStorage.setItem(receiptKey,receipt);else localStorage.removeItem(receiptKey);}catch{/* The visible ID remains available for manual recovery. */}},[receipt,receiptKey]);
  useEffect(()=>{
    const controller=new AbortController();
    try {const endpoint=mailEndpoint(); void fetch(endpoint.requestUrl,{signal:controller.signal}).then(r=>r.ok?r.json():null).then(data=>setEnabled(data?.enabled===true && data.service===endpoint.service)).catch(()=>{});}
    catch { /* Native builds without an API origin stay disabled. */ }
    return ()=>controller.abort();
  },[]);
  const valid=!!normalizeMailAddress(to.trim()) && !!subject.trim() && subject.length<=120 && !/[\x00-\x1f\x7f]/.test(subject) && !!text.trim() && new TextEncoder().encode(text).length<=16384;
  const run=async(action:'send'|'status')=>{
    if(operation.current || mode!=='wallet') return;
    const controller=new AbortController();operation.current=controller;
    setBusy(true);setError(false);
    try {
      const base={service:mailEndpoint().service,wallet:identity.address.toLowerCase(),expiresAt:Date.now()+300000};
      let command:MailCommand;
      if(action==='status') command={...base,action,id:receipt};
      else {
        command=pending?{...pending,expiresAt:base.expiresAt}:{...base,action,id:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),to:normalizeMailAddress(to.trim())!,subject,text};
        setPending(command);setReceipt(command.id);
      }
      setStatus('authorizing');
      const result=await submitWalletEmail(command,controller.signal);
      if(!controller.signal.aborted)setStatus(result.status);
    } catch {if(!controller.signal.aborted){setError(true);setStatus('uncertain');}}
    finally {operation.current=null;if(!controller.signal.aborted)setBusy(false);}
  };
  const terminal=['accepted','stopped','denied','unknown','limited'].includes(status);
  return <div className="card">
    <h2>{t('mail.title')}</h2>
    <p>{t('mail.notice')}</p>
    {!enabled ? <p>{t('mail.disabled')}</p> : <>
      <p>{t('mail.pilot')}</p>
      {mode!=='wallet' && <p>{t('mail.connect')}</p>}
      <Field label={t('routing.recipient')}><input className="input" value={to} disabled={busy||!!pending} onChange={e=>setTo(e.target.value)} /></Field>
      <Field label={t('mail.subject')}><input className="input" maxLength={120} value={subject} disabled={busy||!!pending} onChange={e=>setSubject(e.target.value)} /></Field>
      <Field label={t('mail.message')}><textarea className="input" rows={5} value={text} disabled={busy||!!pending} onChange={e=>setText(e.target.value)} /></Field>
      <Button variant="primary" disabled={busy||mode!=='wallet'||!valid||terminal||(!pending&&!!receipt)} onClick={()=>void run('send')}>{t(pending?'mail.retry':'mail.send')}</Button>
      <Field label={t('mail.receipt')} hint={t('mail.receiptHint')}><input className="input" value={receipt} disabled={busy||!!pending} onChange={e=>setReceipt(e.target.value)} /></Field>
      <Button disabled={busy||mode!=='wallet'||!/^[a-f0-9]{32}$/.test(receipt)} onClick={()=>void run('status')}>{t('mail.check')}</Button>
      {terminal && <Button onClick={()=>{setPending(null);setReceipt('');setStatus('');setSubject('');setText('');}}>{t('mail.new')}</Button>}
      {status && <p role={error?'alert':'status'}>{t(`mail.status.${status}`,t('mail.status.uncertain'))}</p>}
    </>}
  </div>;
}
