import {useEffect,useState} from 'react';
import {profileAddress,type PublicProfile} from '../../../packages/core/src/publicProfile.js';
import {readPublicProfiles,PUBLIC_PROFILE_CHANGED} from './publicProfiles';
import {nameFor} from './useEns';
import {shortAddr} from './ui';
import type {EnsRecord} from './ens';
/** Memory-only, bounded visible set. Expired/unavailable public choices show an address. */
export function usePublicProfiles(addresses:Array<string|undefined>,enabled:boolean){
 const wallets=[...new Set(addresses.filter((v):v is string=>typeof v==='string').map(v=>v.toLowerCase()).filter(profileAddress))].slice(0,50).sort();
 const key=wallets.join(','),[state,setState]=useState<{key:string;at:number;profiles:PublicProfile[]}|null>(null);
 useEffect(()=>{
  let active=true,controller:AbortController|undefined;
  const refresh=()=>{
   controller?.abort();controller=new AbortController();const scope=controller;
   if(!enabled||!wallets.length||document.visibilityState==='hidden'){setState(null);return;}
   void readPublicProfiles(wallets,scope.signal).then(profiles=>{if(active&&!scope.signal.aborted)setState({key,at:performance.now(),profiles});}).catch(()=>{if(active&&!scope.signal.aborted)setState(null);});
  };
  const visible=()=>{setState(null);refresh();};
  refresh();const timer=setInterval(refresh,30000);
  window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);window.addEventListener(PUBLIC_PROFILE_CHANGED,visible);
  return()=>{active=false;controller?.abort();clearInterval(timer);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);window.removeEventListener(PUBLIC_PROFILE_CHANGED,visible);};
 },[key,enabled]);
 useEffect(()=>{if(!state)return;const timer=setTimeout(()=>setState(current=>current===state?null:current),Math.max(0,40000-(performance.now()-state.at)));return()=>clearTimeout(timer);},[state]);
 return new Map(state&&state.key===key&&performance.now()-state.at<40000?state.profiles.map(profile=>[profile.wallet,profile]):[]);
}
export function publicName(address:string,profile:PublicProfile|undefined,ens:EnsRecord|undefined,custom:string|undefined,enabled:boolean){
 if(!enabled||!profileAddress(address.toLowerCase()))return nameFor(address,ens,custom);
 if(!profile)return shortAddr(address);
 return profile.revision===0?nameFor(address,ens,custom):profile.label??shortAddr(address);
}
