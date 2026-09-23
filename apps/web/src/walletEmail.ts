import { stringToHex } from 'viem';
import { mailSignMessage, parseMailReceiptDetails, type MailCommand, type MailReceiptDetails } from '../../../packages/core/src/mailAuth.js';
import { getActiveProvider, getProviderRevision, subscribeProvider } from './walletProviders';
import { syncEndpoint } from './apiEndpoint';
export function mailEndpoint() {
  const endpoint=syncEndpoint();
  return {requestUrl:endpoint.requestUrl.replace(/\/usersync$/, '/mail'),service:endpoint.service.replace(/\/usersync$/, '/mail')};
}
export type WalletEmailResult={status:string;id:string;receipt?:MailReceiptDetails};
export async function submitWalletEmail(command: MailCommand, signal?: AbortSignal) {
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
  if(!response.ok && !['denied','limited','conflict'].includes(result.status)) throw Error('Email service unavailable. Check the request status before creating another message.');
  if(result.id!==command.id || !['queued','sending','accepted','stopped','unknown','denied','limited','conflict'].includes(result.status)) throw Error('Invalid email status response.');
  if(result.receipt!==undefined&&command.action!=='status')throw Error('Unexpected forwarding receipt.');
  const receipt=result.receipt===undefined?undefined:parseMailReceiptDetails(result.receipt,result.status);
  return {status:result.status,id:result.id,...(receipt?{receipt}:{})} as WalletEmailResult;
  } finally {
    unsubscribe();
    provider.removeListener?.('accountsChanged',cancel);
    provider.removeListener?.('disconnect',cancel);
    provider.removeListener?.('session_delete',cancel);
  }
}
