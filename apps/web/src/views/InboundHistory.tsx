import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {INBOUND_HISTORY_SERVICE} from '../../../../packages/core/src/inboundHistory.js';
import {inboundHistoryAvailable,requestInboundHistory,type InboundHistoryPage} from '../inboundHistory';
import {useIdentity} from '../state';
import {useI18n} from '../i18n';
import {getActiveProvider,getProviderRevision,subscribeProvider} from '../walletProviders';
import {Button} from '../ui';
export function InboundHistory(){const {identity,mode}=useIdentity(),revision=useSyncExternalStore(subscribeProvider,getProviderRevision);return mode==='wallet'?<HistorySession key={`${identity.address.toLowerCase()}:${revision}`} wallet={identity.address.toLowerCase()}/>:null;}
export function HistorySession({wallet}:{wallet:string}){
 const {t,lang}=useI18n(),active=useRef(true),operation=useRef<AbortController|null>(null),results=useRef<HTMLElement>(null);
 const [available,setAvailable]=useState(false),[working,setWorking]=useState(false),[failed,setFailed]=useState(false),[page,setPage]=useState<(InboundHistoryPage&{trail:(string|null)[];checkedAt:number})|null>(null);
 useEffect(()=>{active.current=true;const controller=new AbortController();void inboundHistoryAvailable(controller.signal).then(value=>{if(!controller.signal.aborted)setAvailable(value);}).catch(()=>{});return()=>{active.current=false;controller.abort();operation.current?.abort();};},[]);
 useEffect(()=>{const provider=getActiveProvider(),clear=()=>{operation.current?.abort();setPage(null);setFailed(true);};provider?.on?.('accountsChanged',clear);provider?.on?.('disconnect',clear);provider?.on?.('session_delete',clear);return()=>{provider?.removeListener?.('accountsChanged',clear);provider?.removeListener?.('disconnect',clear);provider?.removeListener?.('session_delete',clear);};},[]);
 useEffect(()=>{if(page)results.current?.focus({preventScroll:true});},[page]);
 const read=async(trail:(string|null)[]=[null])=>{
  if(operation.current)return;const controller=new AbortController();operation.current=controller;setWorking(true);setFailed(false);setPage(null);
  try{
   const result=await requestInboundHistory({action:'history',service:INBOUND_HISTORY_SERVICE,wallet,id:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),expiresAt:Date.now()+300000,cursor:trail.at(-1)??null},controller.signal);
   if(!active.current||controller.signal.aborted)return;if(result.nextCursor&&(trail.includes(result.nextCursor)||trail.length>=1280))throw Error('History changed.');setPage({...result,trail,checkedAt:Date.now()});
  }catch{if(active.current&&!controller.signal.aborted)setFailed(true);}
  finally{operation.current=null;if(active.current)setWorking(false);}
 };
 const date=(at:number)=><time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString(lang)}</time>;
 if(!available)return null;
 return <details className="email-recovery inbound-email-history" data-insights-ignore="true"><summary>{t('inboundHistory.title')}</summary><p>{t('inboundHistory.scope')}</p><p>{t('inboundHistory.coverage')}</p>
  <Button disabled={working} onClick={()=>void read()}>{t('inboundHistory.check')}</Button>
  {working&&<p role="status">{t('inboundHistory.working')}</p>}{failed&&<p role="alert">{t('inboundHistory.failed')}</p>}
  {page&&<section ref={results} tabIndex={-1} aria-label={t('inboundHistory.results')}><p>{t('mail.history.checked')} {date(page.checkedAt)}</p>
   {!page.records.length?<p>{t('inboundHistory.empty')}</p>:<ul>{page.records.map(record=><li key={record.id} className="wallet-email-receipt"><code style={{overflowWrap:'anywhere'}}>{record.id}</code><p>{t('inboundHistory.'+record.status)}</p><dl>
    <dt>{t('mail.history.queued')}</dt><dd>{date(record.createdAt)}</dd><dt>{t('mail.history.updated')}</dt><dd>{record.updatedAt===null?t('mail.history.unavailable'):date(record.updatedAt)}</dd><dt>{t('inboundHistory.attempts')}</dt><dd>{record.attempts}</dd><dt>{t('inboundHistory.deadline')}</dt><dd>{date(record.deadline)}</dd>
   </dl></li>)}</ul>}
   {page.trail.length>1&&<Button disabled={working} onClick={()=>void read(page.trail.slice(0,-1))}>{t('mailDiscovery.newer')}</Button>}{' '}{page.nextCursor&&<Button disabled={working} onClick={()=>void read([...page.trail,page.nextCursor])}>{t('mailDiscovery.older')}</Button>}
  </section>}
 </details>;
}
