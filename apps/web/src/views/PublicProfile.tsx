import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useIdentity} from '../state';
import {getProviderRevision,subscribeProvider} from '../walletProviders';
import {readPublicProfiles,publishPublicProfile} from '../publicProfiles';
import {profileLabel,type PublicProfile as Profile} from '../../../../packages/core/src/publicProfile.js';
import {Button,Field} from '../ui';
import {useI18n} from '../i18n';
export function PublicProfile(){
 const {identity,mode}=useIdentity(),revision=useSyncExternalStore(subscribeProvider,getProviderRevision);
 return mode==='wallet'?<ProfileEditor key={`${identity.address.toLowerCase()}:${revision}`} wallet={identity.address.toLowerCase()}/>:null;
}
function ProfileEditor({wallet}:{wallet:string}){
 const {t}=useI18n();const [profile,setProfile]=useState<Profile|null>(null),[label,setLabel]=useState(''),[showName,setShowName]=useState(false),[consent,setConsent]=useState(false),[working,setWorking]=useState(false),[status,setStatus]=useState('');
 const operation=useRef<AbortController|null>(null),active=useRef(true);
 const load=async()=>{
  if(operation.current)return;const controller=new AbortController();operation.current=controller;setWorking(true);setStatus('');setConsent(false);
  try{const [value]=await readPublicProfiles([wallet],controller.signal);if(active.current&&!controller.signal.aborted){setProfile(value);setLabel(value.label??'');setShowName(value.label!==null);}}
  catch{if(active.current&&!controller.signal.aborted){setProfile(null);setStatus('failed');}}
  finally{if(operation.current===controller)operation.current=null;if(active.current&&!controller.signal.aborted)setWorking(false);}
 };
 useEffect(()=>{active.current=true;void load();return()=>{active.current=false;operation.current?.abort();operation.current=null;};},[]);
 const save=async()=>{
  if(!profile||!consent||operation.current||!profileLabel(showName?label.trim():null))return;
  const controller=new AbortController();operation.current=controller;setWorking(true);setStatus('');
  try{
   const result=await publishPublicProfile(wallet,profile.revision,showName?label.trim():null,controller.signal);
   if(active.current&&!controller.signal.aborted){setProfile(result);setLabel(result.label??'');setConsent(false);setStatus(result.label===null?'withdrawn':'saved');}
  }catch{if(active.current&&!controller.signal.aborted){setProfile(null);setConsent(false);setStatus('uncertain');}}
  finally{if(operation.current===controller)operation.current=null;if(active.current&&!controller.signal.aborted)setWorking(false);}
 };
 return <section className="card" data-insights-ignore="true" aria-label={t('publicProfile.title')}>
  <h2>{t('publicProfile.title')}</h2><p>{t('publicProfile.notice')}</p>
  <p><code>{wallet}</code></p>
  {profile&&<p>{t('publicProfile.current')}: {profile.revision===0?t('publicProfile.unset'):profile.label??t('publicProfile.addressOnly')}</p>}
  <Field label={t('publicProfile.visibility')}><select className="input" disabled={working||!profile} value={showName?'name':'address'} onChange={e=>{setShowName(e.target.value==='name');setConsent(false);setStatus('');}}>
   <option value="address">{t('publicProfile.addressOnly')}</option><option value="name">{t('publicProfile.nameOption')}</option>
  </select></Field>
  {showName&&<Field label={t('publicProfile.name')}><input className="input" maxLength={80} value={label} disabled={working||!profile} onChange={e=>{setLabel(e.target.value);setConsent(false);setStatus('');}}/></Field>}
  <p>{t('publicProfile.preview')}: <strong>{showName?label.trim():wallet}</strong></p>
  <label><input type="checkbox" checked={consent} disabled={working||!profile} onChange={e=>setConsent(e.target.checked)}/> {t(showName?'publicProfile.consent':'publicProfile.withdrawConsent')}</label>
  <div className="local-actions"><Button disabled={working||!profile||!consent||!profileLabel(showName?label.trim():null)} onClick={()=>void save()}>{t(showName?'publicProfile.publish':'publicProfile.withdraw')}</Button>
   <Button disabled={working} onClick={()=>void load()}>{t('publicProfile.reload')}</Button></div>
  {working&&<p role="status">{t('publicProfile.working')}</p>}
  {status&&<p role={['failed','uncertain'].includes(status)?'alert':'status'}>{t(`publicProfile.${status}`)}</p>}
 </section>;
}
