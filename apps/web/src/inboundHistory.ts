import {stringToHex} from 'viem';
import {INBOUND_HISTORY_SERVICE,inboundHistorySignMessage,validInboundHistoryCommand,parseInboundHistoryRecord,type InboundHistoryCommand,type InboundHistoryRecord} from '../../../packages/core/src/inboundHistory.js';
import {getActiveProvider,getProviderRevision,subscribeProvider} from './walletProviders';
import {mailEndpoint} from './walletEmail';
export type InboundHistoryPage={records:InboundHistoryRecord[];nextCursor:string|null};
const endpoint=()=>mailEndpoint().requestUrl+'/inbound-history';
async function json(response:Response){
 if(!response.body)throw Error('Missing history response.');const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){void reader.cancel().catch(()=>{});throw Error('History response too large.');}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export async function inboundHistoryAvailable(signal?:AbortSignal){
 const response=await fetch(endpoint(),{redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])])});
 if(!response.ok)return false;const data=await json(response);signal?.throwIfAborted();return data.enabled===true&&data.version===1&&data.service===INBOUND_HISTORY_SERVICE;
}
export async function requestInboundHistory(command:InboundHistoryCommand,signal?:AbortSignal):Promise<InboundHistoryPage>{
 if(!validInboundHistoryCommand(command))throw Error('Invalid history command.');
 const provider=getActiveProvider(),revision=getProviderRevision();if(!provider)throw Error('Connect a wallet.');
 const cancelled=new AbortController(),cancel=()=>cancelled.abort();const scope=AbortSignal.any([cancelled.signal,AbortSignal.timeout(120000),...(signal?[signal]:[])]);
 const unsubscribe=subscribeProvider(cancel);
 const current=()=>{scope.throwIfAborted();if(getActiveProvider()!==provider||getProviderRevision()!==revision)throw Error('Wallet changed.');};
 const ask=async(args:Parameters<typeof provider.request>[0])=>{
  current();let reject!:(reason:unknown)=>void;const aborted=new Promise<never>((_resolve,r)=>reject=r);const stop=()=>reject(Error('History session ended.'));scope.addEventListener('abort',stop,{once:true});
  try{const value=await Promise.race([provider.request(args),aborted]);current();return value;}finally{scope.removeEventListener('abort',stop);}
 };
 const accounts=async()=>{const values=await ask({method:'eth_accounts'});if(!Array.isArray(values)||String(values[0]).toLowerCase()!==command.wallet)throw Error('Wallet changed.');};
 try{
  provider.on?.('accountsChanged',cancel);provider.on?.('disconnect',cancel);provider.on?.('session_delete',cancel);
  await accounts();const signature=await ask({method:'personal_sign',params:[stringToHex(inboundHistorySignMessage(command)),command.wallet]});await accounts();
  const response=await fetch(endpoint(),{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,signature}),signal:AbortSignal.any([scope,AbortSignal.timeout(15000)])});
  const data=await json(response);await accounts();current();
  if(!response.ok||data.status!=='history'||data.service!==command.service||data.wallet!==command.wallet||data.id!==command.id||data.cursor!==command.cursor||!Array.isArray(data.records)||data.records.length>25||!(data.nextCursor===null||typeof data.nextCursor==='string'&&/^[a-f0-9]{64}$/.test(data.nextCursor)&&data.nextCursor!==command.cursor))throw Error('Incoming history changed.');
  const records:InboundHistoryRecord[]=data.records.map(parseInboundHistoryRecord);if(new Set(records.map(r=>r.id)).size!==records.length)throw Error('Duplicate history.');return {records,nextCursor:data.nextCursor};
 }finally{unsubscribe();provider.removeListener?.('accountsChanged',cancel);provider.removeListener?.('disconnect',cancel);provider.removeListener?.('session_delete',cancel);}
}
