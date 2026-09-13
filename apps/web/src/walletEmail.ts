import { stringToHex } from 'viem';
import { mailSignMessage, type MailCommand } from '../../../packages/core/src/mailAuth.js';
import { getActiveProvider } from './walletProviders';
import { syncEndpoint } from './apiEndpoint';
export function mailEndpoint() {
  const endpoint=syncEndpoint();
  return {requestUrl:endpoint.requestUrl.replace(/\/usersync$/, '/mail'),service:endpoint.service.replace(/\/usersync$/, '/mail')};
}
export async function submitWalletEmail(command: MailCommand) {
  const endpoint=mailEndpoint();
  if(command.service!==endpoint.service) throw Error('Email service identity changed.');
  const provider=getActiveProvider(); if(!provider) throw Error('Connect your wallet first.');
  const check=async()=>{
    const accounts=await provider.request({method:'eth_accounts'});
    if(!Array.isArray(accounts)||String(accounts[0]).toLowerCase()!==command.wallet) throw Error('Wallet account changed. Reconnect before continuing.');
  };
  await check();
  const signature=await provider.request({method:'personal_sign',params:[stringToHex(mailSignMessage(command)),command.wallet]});
  await check();
  const response=await fetch(endpoint.requestUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,signature}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(!response.ok && !['denied','limited','conflict'].includes(result.status)) throw Error('Email service unavailable. Check the request status before creating another message.');
  if(result.id!==command.id || !['queued','sending','accepted','stopped','unknown','denied','limited','conflict'].includes(result.status)) throw Error('Invalid email status response.');
  return result as {status:string;id:string};
}
