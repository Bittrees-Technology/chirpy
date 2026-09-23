import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {submitWalletEmail,discoverWalletEmail} from '../src/walletEmail';
import {clearActiveProvider,setActiveProvider,type WalletEventProvider} from '../src/walletProviders';
import type {MailCommand} from '../../../packages/core/src/mailAuth.js';

vi.mock('../src/apiEndpoint',()=>({syncEndpoint:()=>({requestUrl:'https://chat.example/api/usersync',service:'https://chat.example/api/usersync'})}));
const wallet='0x'+'1'.repeat(40);
const command=():MailCommand=>({action:'status',service:'https://chat.example/api/mail',wallet,id:'a'.repeat(32),expiresAt:Date.now()+60000});
let request:ReturnType<typeof vi.fn>,fetcher:ReturnType<typeof vi.fn>,provider:WalletEventProvider,listeners:Map<string,Set<()=>void>>;
function emit(event:string){for(const fn of listeners.get(event)??[])fn();}
function replacement(){setActiveProvider({request:async()=>[wallet]},'injected');}
beforeEach(()=>{
 listeners=new Map();
 request=vi.fn(async({method})=>method==='eth_accounts'?[wallet]:'0x'+'2'.repeat(130));
 provider={request,on:(event,fn)=>{const callbacks=listeners.get(event)??new Set();callbacks.add(fn as ()=>void);listeners.set(event,callbacks);},removeListener:(event,fn)=>{listeners.get(event)?.delete(fn as ()=>void);}};
 setActiveProvider(provider,'injected');
 fetcher=vi.fn(async()=>Response.json({id:command().id,status:'queued'}));vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{clearActiveProvider();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('checks the same wallet around signing and response and removes listeners',async()=>{
 expect(await submitWalletEmail(command())).toEqual({id:command().id,status:'queued'});
 expect(request.mock.calls.map(([r])=>r.method)).toEqual(['eth_accounts','personal_sign','eth_accounts','eth_accounts']);
 expect(fetcher.mock.calls[0][1].redirect).toBe('error');
 expect([...listeners.values()].every(v=>v.size===0)).toBe(true);
});
it.each(['replacement','disconnect','accountsChanged','session_delete','reconnect'])('does not submit after %s during signing',async(event)=>{
 request.mockImplementation(async({method})=>{
  if(method==='personal_sign'){
   if(event==='replacement')replacement();
   else if(event==='reconnect'){clearActiveProvider();setActiveProvider(provider,'injected');}
   else emit(event);
   return '0x'+'2'.repeat(130);
  }
  return [wallet];
 });
 await expect(submitWalletEmail(command())).rejects.toThrow();
 expect(fetcher).not.toHaveBeenCalled();expect([...listeners.values()].every(v=>v.size===0)).toBe(true);
});
it('rechecks connection after an asynchronous account read before opening signing',async()=>{
 request.mockImplementation(async()=>{replacement();return [wallet];});
 await expect(submitWalletEmail(command())).rejects.toThrow();
 expect(request).toHaveBeenCalledTimes(1);expect(fetcher).not.toHaveBeenCalled();
});
it('rejects silent account changes before submission or accepting a late response',async()=>{
 let reads=0;request.mockImplementation(async({method})=>method==='eth_accounts'?[++reads===1?wallet:'0x'+'3'.repeat(40)]:'0x'+'2'.repeat(130));
 await expect(submitWalletEmail(command())).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
 reads=0;request.mockImplementation(async({method})=>method==='eth_accounts'?[++reads<3?wallet:'0x'+'3'.repeat(40)]:'0x'+'2'.repeat(130));
 await expect(submitWalletEmail(command())).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
});
it('aborts an in-flight HTTP request on provider replacement even if a late response arrives',async()=>{
 fetcher.mockImplementation(async()=>{replacement();return Response.json({id:command().id,status:'accepted'});});
 await expect(submitWalletEmail(command())).rejects.toThrow();
 expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
it('screen cancellation prevents late signature dispatch and rejects an already-cancelled operation',async()=>{
 const controller=new AbortController();
 request.mockImplementation(async({method})=>{if(method==='personal_sign')controller.abort();return method==='eth_accounts'?[wallet]:'0x'+'2'.repeat(130);});
 await expect(submitWalletEmail(command(),controller.signal)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
 request.mockClear();await expect(submitWalletEmail(command(),controller.signal)).rejects.toThrow();expect(request).not.toHaveBeenCalled();
});

const details=()=>({version:1,createdAt:1700000000000,updatedAt:1700000001000,attempts:1,retryUntil:1700082800000});
it('returns validated receipt metadata while dropping unrelated response fields',async()=>{
 fetcher.mockResolvedValue(Response.json({id:command().id,status:'accepted',receipt:details(),private:'must not reach UI'}));
 expect(await submitWalletEmail(command())).toEqual({id:command().id,status:'accepted',receipt:details()});
});
it.each([{version:2},{attempts:6},{attempts:0},{createdAt:-1},{updatedAt:1},{retryUntil:1700082800001},{providerId:'private'}])('rejects invalid or expanded receipt metadata %j',async patch=>{
 fetcher.mockResolvedValue(Response.json({id:command().id,status:'accepted',receipt:{...details(),...patch}}));await expect(submitWalletEmail(command())).rejects.toThrow();
});
it('does not attach receipt evidence to unknown requests or send responses',async()=>{
 fetcher.mockResolvedValue(Response.json({id:command().id,status:'unknown',receipt:details()}));await expect(submitWalletEmail(command())).rejects.toThrow();
 fetcher.mockResolvedValue(Response.json({id:command().id,status:'accepted',receipt:details()}));await expect(submitWalletEmail({...command(),action:'send',to:'fixture@example.com',subject:'Fixture',text:'Synthetic'})).rejects.toThrow();
});

const historyCommand=()=>({...command(),action:'history' as const,cursor:null});
const historyResult=()=>({status:'history',...historyCommand(),ids:['b'.repeat(32)],nextCursor:null});
it('signs bounded discovery and returns only matching IDs and pagination',async()=>{
 fetcher.mockResolvedValue(Response.json({...historyResult(),private:'ignored'}));expect(await discoverWalletEmail(historyCommand())).toEqual({ids:['b'.repeat(32)],nextCursor:null});
 expect(JSON.parse(fetcher.mock.calls[0][1].body).command.action).toBe('history');
});
it.each([{wallet:'0x'+'2'.repeat(40)},{service:'https://other.example/api/mail'},{cursor:'c'.repeat(64)},{ids:['x']},{ids:Array(26).fill('b'.repeat(32))},{ids:['b'.repeat(32),'b'.repeat(32)]},{nextCursor:'bad'},{status:'accepted'}])('rejects invalid or mismatched history results %j',async patch=>{
 fetcher.mockResolvedValue(Response.json({...historyResult(),...patch}));await expect(discoverWalletEmail(historyCommand())).rejects.toThrow();
});
it('rejects history responses after provider replacement and invalid cursors before signing',async()=>{
 await expect(discoverWalletEmail({...historyCommand(),cursor:'bad'})).rejects.toThrow();expect(request).not.toHaveBeenCalled();
 fetcher.mockImplementation(async()=>{replacement();return Response.json(historyResult());});await expect(discoverWalletEmail(historyCommand())).rejects.toThrow();
});

it('returns only validated provider event evidence for signed accepted-status queries',async()=>{
 const delivery={version:1,events:[{type:'bounced',occurredAt:1700000001000},{type:'delivered',occurredAt:1700000000000}]};
 fetcher.mockResolvedValue(Response.json({id:command().id,status:'accepted',delivery,private:'ignored'}));expect((await submitWalletEmail(command())).delivery?.events.map(e=>e.type)).toEqual(['delivered','bounced']);
});
it.each([{version:2,events:[]},{version:1,events:[{type:'read',occurredAt:1}]},{version:1,events:[{type:'delivered',occurredAt:0}]},{version:1,events:[],recipient:'private'}])('rejects invalid provider evidence before showing it',async delivery=>{
 fetcher.mockResolvedValue(Response.json({id:command().id,status:'accepted',delivery}));await expect(submitWalletEmail(command())).rejects.toThrow();
});
it('refuses delivery evidence on send, queued or unknown responses',async()=>{
 const delivery={version:1,events:[]};
 for(const status of ['queued','unknown']){fetcher.mockResolvedValue(Response.json({id:command().id,status,delivery}));await expect(submitWalletEmail(command())).rejects.toThrow();}
 fetcher.mockResolvedValue(Response.json({id:command().id,status:'accepted',delivery}));await expect(submitWalletEmail({...command(),action:'send'})).rejects.toThrow();
});
