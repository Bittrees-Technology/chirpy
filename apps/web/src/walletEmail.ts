import { stringToHex } from 'viem';
import { mailSignMessage, parseMailReceiptDetails, parseMailDeliveryDetails, type MailDeliveryDetails, type MailCommand, type MailHistoryCommand, type MailReceiptDetails } from '../../../packages/core/src/mailAuth.js';
import { getActiveProvider, getProviderRevision, subscribeProvider } from './walletProviders';
import { syncEndpoint } from './apiEndpoint';
export function mailEndpoint() {
  const endpoint=syncEndpoint();
  return {requestUrl:endpoint.requestUrl.replace(/\/usersync$/, '/mail'),service:endpoint.service.replace(/\/usersync$/, '/mail')};
}
export type WalletEmailResult={status:string;id:string;receipt?:MailReceiptDetails;delivery?:MailDeliveryDetails};
async function requestWalletEmail<T>(command:MailCommand|MailHistoryCommand,parse:(response:Response,result:any)=>T,signal?:AbortSignal):Promise<T> {
  const endpoint=mailEndpoint();
  if(command.service!==endpoint.service) throw Error('Email service identity changed.');
  const provider=getActiveProvider(); if(!provider) throw Error('Connect your wallet first.');
  const revision=getProviderRevision();
  const cancelled=new AbortController();
  const cancel=()=>cancelled.abort();
  const scope=AbortSignal.any([cancelled.signal,...(signal?[signal]:[])]);
  const unsubscribe=subscribeProvider(cancel);
  const current=()=>{
    scope.throwIfAborted();
    if(getActiveProvider()!==provider||getProviderRevision()!==revision) throw Error('Wallet connection changed. Reconnect before continuing.');
  };
  const check=async()=>{
    current();
    const accounts=await provider.request({method:'eth_accounts'});
    current();
    if(!Array.isArray(accounts)||String(accounts[0]).toLowerCase()!==command.wallet) throw Error('Wallet account changed. Reconnect before continuing.');
  };
  try {
  provider.on?.('accountsChanged',cancel);
  provider.on?.('disconnect',cancel);
  provider.on?.('session_delete',cancel);
  await check();
  const signature=await provider.request({method:'personal_sign',params:[stringToHex(mailSignMessage(command)),command.wallet]});
  await check();
  const response=await fetch(endpoint.requestUrl,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,signature}),signal:AbortSignal.any([scope,AbortSignal.timeout(15000)])});
  const result=await response.json();
  await check();
  return parse(response,result);
  } finally {
    unsubscribe();
    provider.removeListener?.('accountsChanged',cancel);
    provider.removeListener?.('disconnect',cancel);
    provider.removeListener?.('session_delete',cancel);
  }
}

export async function submitWalletEmail(command:MailCommand,signal?:AbortSignal){
 return requestWalletEmail(command,(response,result)=>{
  if(!response.ok && !['denied','limited','conflict'].includes(result.status)) throw Error('Email service unavailable. Check the request status before creating another message.');
  if(result.id!==command.id || !['queued','sending','accepted','stopped','unknown','denied','limited','conflict'].includes(result.status)) throw Error('Invalid email status response.');
  if(result.receipt!==undefined&&command.action!=='status')throw Error('Unexpected forwarding receipt.');
  const receipt=result.receipt===undefined?undefined:parseMailReceiptDetails(result.receipt,result.status);
  if(result.delivery!==undefined&&(command.action!=='status'||result.status!=='accepted'))throw Error('Unexpected provider delivery evidence.');
  const delivery=result.delivery===undefined?undefined:parseMailDeliveryDetails(result.delivery);
  return {status:result.status,id:result.id,...(receipt?{receipt}:{}),...(delivery?{delivery}:{})} as WalletEmailResult;
 },signal);
}
export type WalletEmailHistory={ids:string[];nextCursor:string|null};
export async function discoverWalletEmail(command:MailHistoryCommand,signal?:AbortSignal):Promise<WalletEmailHistory>{
 if(command.action!=='history'||!/^0x[a-f0-9]{40}$/.test(command.wallet)||! /^[a-f0-9]{32}$/.test(command.id)||!Number.isSafeInteger(command.expiresAt)||command.expiresAt<=Date.now()||command.expiresAt>Date.now()+300000||!(command.cursor===null||/^[a-f0-9]{64}$/.test(command.cursor)))throw Error('Invalid history authorization.');
 return requestWalletEmail(command,(response,result)=>{
  if(!response.ok||result.status!=='history'||result.id!==command.id||result.wallet!==command.wallet||result.service!==command.service||result.cursor!==command.cursor||!Array.isArray(result.ids)||result.ids.length>25||result.ids.some((id:unknown)=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))||new Set(result.ids).size!==result.ids.length||!(result.nextCursor===null||typeof result.nextCursor==='string'&&/^[a-f0-9]{64}$/.test(result.nextCursor)&&result.nextCursor!==command.cursor))throw Error('Forwarding history changed or is unavailable. Start a fresh lookup.');
  return {ids:[...result.ids],nextCursor:result.nextCursor};
 },signal);
}
