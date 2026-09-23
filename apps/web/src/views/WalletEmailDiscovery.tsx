import React,{useEffect,useRef,useState} from 'react';
import {Button} from '../ui';
import {useI18n} from '../i18n';
import {discoverWalletEmail,type WalletEmailHistory} from '../walletEmail';
import {verifyRecoveryWallet} from '../recoveryWallet';
import {snapshotWalletEmailRecovery,type WalletEmailSnapshot} from '../walletEmailReceipts';
import {mergeWalletEmailArchive,restoreWalletEmailArchive} from '../walletEmailArchiveStorage';
import type {WalletEmailArchive} from '../walletEmailArchive';

/** The parent remounts this view when the wallet, provider or service session changes. */
export function WalletEmailDiscovery({wallet,service}:{wallet:string;service:string}){
 const {t}=useI18n(),operation=useRef<AbortController|null>(null),active=useRef(true),latest=useRef('');
 const scope=JSON.stringify([wallet,service]);latest.current=scope;
 const [working,setWorking]=useState(false),[status,setStatus]=useState('');
 const [page,setPage]=useState<(WalletEmailHistory&{trail:(string|null)[]})|null>(null);
 const [review,setReview]=useState<{data:WalletEmailArchive;snapshot:WalletEmailSnapshot}|null>(null);
 useEffect(()=>{active.current=true;return()=>{active.current=false;operation.current?.abort();};},[]);
 const current=()=>{if(!active.current||latest.current!==scope||operation.current?.signal.aborted)throw Error('History session changed');};
 const find=async(trail:(string|null)[]=[null])=>{
  if(operation.current)return;const controller=new AbortController();operation.current=controller;setWorking(true);setStatus('');setPage(null);setReview(null);
  try{
   const cursor=trail.at(-1)??null;
   const result=await discoverWalletEmail({action:'history',service,wallet,id:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),expiresAt:Date.now()+300000,cursor},controller.signal);
   current();if(result.nextCursor&&(trail.includes(result.nextCursor)||trail.length>=26))throw Error('History changed');
   const snapshot=snapshotWalletEmailRecovery(wallet,service),data:WalletEmailArchive={version:1,wallet,service,createdAt:Date.now(),active:result.ids[0]??null,ids:result.ids};
   setPage({...result,trail});
   try{mergeWalletEmailArchive(snapshot,data,wallet,service);}catch{setStatus('capacity');return;}
   setReview({data,snapshot});if(!result.ids.length)setStatus('empty');
  }catch{if(active.current&&latest.current===scope)setStatus('failed');}
  finally{operation.current=null;if(active.current&&latest.current===scope)setWorking(false);}
 };
 const save=async()=>{
  if(operation.current||!review)return;const controller=new AbortController();operation.current=controller;setWorking(true);setStatus('');
  let proof:Awaited<ReturnType<typeof verifyRecoveryWallet>>|undefined;
  try{
   proof=await verifyRecoveryWallet(wallet,current,'restore');await proof.assertCurrent();current();
   await restoreWalletEmailArchive(review.data,wallet,service,review.snapshot.revision,()=>{current();proof!.assertSession();},controller.signal);
   current();setReview(null);setStatus('saved');
  }catch{if(active.current&&latest.current===scope){setReview(null);setStatus('failed');}}
  finally{proof?.dispose();operation.current=null;if(active.current&&latest.current===scope)setWorking(false);}
 };
 return <details className="email-recovery wallet-email-discovery" data-insights-ignore="true">
  <summary>{t('mailDiscovery.title')}</summary><p>{t('mailDiscovery.scope')}</p><p>{t('mailDiscovery.coverage')}</p>
  <Button disabled={working} onClick={()=>void find()}>{t('mailDiscovery.find')}</Button>
  {page&&<section aria-label={t('mailDiscovery.review')}>
   <p>{t('mailDiscovery.count',undefined,{count:page.ids.length})}</p><ul>{page.ids.map(id=><li key={id}><code>{id}</code></li>)}</ul>
   <p>{t('mailDiscovery.saveHint')}</p>
   <Button disabled={working||!review||!page.ids.length} onClick={()=>void save()}>{t('mailDiscovery.save')}</Button>{' '}
   {page.trail.length>1&&<Button disabled={working} onClick={()=>void find(page.trail.slice(0,-1))}>{t('mailDiscovery.newer')}</Button>}{' '}
   {page.nextCursor&&<Button disabled={working} onClick={()=>void find([...page.trail,page.nextCursor])}>{t('mailDiscovery.older')}</Button>}
  </section>}
  {working&&<p role="status">{t('mailDiscovery.working')}</p>}
  {status&&<p role={['failed','capacity'].includes(status)?'alert':'status'}>{t('mailDiscovery.'+status)}</p>}
 </details>;
}
