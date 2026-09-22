import {stringToHex} from 'viem';
import {syncEndpoint} from './apiEndpoint';
import {getActiveProvider,getProviderRevision,subscribeProvider} from './walletProviders';
import {profileAddress,profileLabel,profileSignMessage,validPublicProfile,type ProfileCommand,type PublicProfile} from '../../../packages/core/src/publicProfile.js';
export const PUBLIC_PROFILE_CHANGED='chat:public-profile-changed';
export function publicProfileEndpoint(){const e=syncEndpoint();return {service:e.service.replace(/\/usersync$/,'/profile'),requestUrl:e.requestUrl.replace(/\/usersync$/,'/profile')};}
async function body(response:Response){
 if(!response.ok)throw Error('Public profile request failed');
 const reader=response.body?.getReader();if(!reader)throw Error('Missing response');
 const parts:Uint8Array[]=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>40000)throw Error('Profile response too large');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const data=new Uint8Array(length);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
}
export async function readPublicProfiles(wallets:string[],signal?:AbortSignal):Promise<PublicProfile[]>{
 if(!wallets.length||wallets.length>50||!wallets.every(profileAddress)||new Set(wallets).size!==wallets.length)throw Error('Invalid wallets');
 const endpoint=publicProfileEndpoint();
 const response=await fetch(`${endpoint.requestUrl}?wallet=${encodeURIComponent(wallets.join(','))}`,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.any([AbortSignal.timeout(8000),...(signal?[signal]:[])])});
 const result=await body(response);
 if(result.service!==endpoint.service||!Array.isArray(result.profiles)||result.profiles.length!==wallets.length||!result.profiles.every((item:unknown,i:number)=>validPublicProfile(item,wallets[i])))throw Error('Invalid public profiles');
 signal?.throwIfAborted();return result.profiles;
}
export async function publishPublicProfile(wallet:string,revision:number,label:string|null,signal:AbortSignal):Promise<PublicProfile>{
 if(!profileAddress(wallet)||!profileLabel(label))throw Error('Invalid profile');
 const endpoint=publicProfileEndpoint(),provider=getActiveProvider(),generation=getProviderRevision(),cancelled=new AbortController();
 if(!provider)throw Error('Connect wallet');
 const cancel=()=>cancelled.abort(),scope=AbortSignal.any([signal,cancelled.signal]);const unsubscribe=subscribeProvider(cancel);
 const current=()=>{scope.throwIfAborted();if(getActiveProvider()!==provider||getProviderRevision()!==generation)throw Error('Wallet changed');};
 const check=async()=>{current();const accounts=await provider.request({method:'eth_accounts'});current();if(!Array.isArray(accounts)||String(accounts[0]).toLowerCase()!==wallet)throw Error('Wallet changed');};
 try{
  provider.on?.('accountsChanged',cancel);provider.on?.('disconnect',cancel);provider.on?.('session_delete',cancel);
  await check();const command:ProfileCommand={version:1,service:endpoint.service,wallet,revision,label,expiresAt:Date.now()+300000};
  const signature=await provider.request({method:'personal_sign',params:[stringToHex(profileSignMessage(command)),wallet]});await check();
  const result=await body(await fetch(endpoint.requestUrl,{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,signature}),signal:AbortSignal.any([scope,AbortSignal.timeout(30000)])}));
  await check();if(result.service!==endpoint.service||result.status!=='saved'||!validPublicProfile(result.profile,wallet)||result.profile.revision!==revision+1||result.profile.label!==label)throw Error('Profile outcome unknown');
  window.dispatchEvent(new CustomEvent(PUBLIC_PROFILE_CHANGED));return result.profile;
 }finally{unsubscribe();provider.removeListener?.('accountsChanged',cancel);provider.removeListener?.('disconnect',cancel);provider.removeListener?.('session_delete',cancel);}
}
