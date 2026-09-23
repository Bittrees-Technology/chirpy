import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {requestInboundHistory,inboundHistoryAvailable} from '../src/inboundHistory';
import {clearActiveProvider,setActiveProvider,type WalletEventProvider} from '../src/walletProviders';
import {INBOUND_HISTORY_SERVICE} from '../../../packages/core/src/inboundHistory.js';
vi.mock('../src/walletEmail',()=>({mailEndpoint:()=>({requestUrl:'https://chat.example/api/mail'})}));
const wallet='0x'+'1'.repeat(40),command=()=>({action:'history' as const,service:INBOUND_HISTORY_SERVICE,wallet,id:'a'.repeat(32),cursor:null,expiresAt:Date.now()+300000});
const record={id:'b'.repeat(64),status:'published',createdAt:1700000000000,updatedAt:1700000001000,deadline:1700000060000,attempts:1};
const result=()=>({...command(),status:'history',records:[record],nextCursor:null});
let request:ReturnType<typeof vi.fn>,fetcher:ReturnType<typeof vi.fn>,provider:WalletEventProvider,listeners:Map<string,Set<()=>void>>;
const emit=(event:string)=>{for(const fn of listeners.get(event)??[])fn();};
beforeEach(()=>{
 listeners=new Map();request=vi.fn(async({method})=>method==='eth_accounts'?[wallet]:'0x'+'2'.repeat(130));
 provider={request,on:(event,fn)=>{const callbacks=listeners.get(event)??new Set();callbacks.add(fn as ()=>void);listeners.set(event,callbacks);},removeListener:(event,fn)=>listeners.get(event)?.delete(fn as ()=>void)};setActiveProvider(provider,'injected');
 fetcher=vi.fn(async()=>Response.json(result()));vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{clearActiveProvider();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('signs a separate bounded read and validates wallet, endpoint, nonce and cursor',async()=>{
 expect(await requestInboundHistory(command())).toEqual({records:[record],nextCursor:null});expect(fetcher.mock.calls[0][0]).toBe('https://chat.example/api/mail/inbound-history');expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:'omit',redirect:'error',cache:'no-store'});expect([...listeners.values()].every(s=>s.size===0)).toBe(true);
});
it.each([{wallet:'0x'+'2'.repeat(40)},{id:'c'.repeat(32)},{service:'https://other.test'},{cursor:'d'.repeat(64)},{records:Array(26).fill(record)},{records:[record,record]},{records:[{...record,mailbox:'private'}]},{nextCursor:'x'}])('rejects mismatched or expanded responses',async patch=>{
 fetcher.mockResolvedValueOnce(Response.json({...result(),...patch}));await expect(requestInboundHistory(command())).rejects.toThrow();
});
it.each(['accountsChanged','disconnect','session_delete','replacement'])('rejects wallet %s during signing before any history request',async event=>{
 request.mockImplementation(async({method})=>{if(method==='personal_sign'){if(event==='replacement')setActiveProvider({request},'injected');else emit(event);}return method==='eth_accounts'?[wallet]:'0x'+'2'.repeat(130);});
 await expect(requestInboundHistory(command())).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();expect([...listeners.values()].every(s=>s.size===0)).toBe(true);
});
it('drops a late response after provider replacement and bounds oversized responses',async()=>{
 fetcher.mockImplementationOnce(async()=>{setActiveProvider({request},'injected');return Response.json(result());});await expect(requestInboundHistory(command())).rejects.toThrow();
 fetcher.mockResolvedValueOnce(new Response('x'.repeat(32769)));await expect(requestInboundHistory(command())).rejects.toThrow('too large');
});
it('ends a pending wallet request on explicit cancellation without dispatching a late signature',async()=>{
 const controller=new AbortController();let resolve!:(value:unknown)=>void;request.mockImplementation(({method})=>method==='personal_sign'?new Promise(r=>resolve=r):Promise.resolve([wallet]));
 const pending=requestInboundHistory(command(),controller.signal);await vi.waitFor(()=>expect(resolve).toBeTruthy());const rejected=expect(pending).rejects.toThrow();controller.abort();await rejected;resolve('0x'+'2'.repeat(130));await Promise.resolve();expect(fetcher).not.toHaveBeenCalled();
});
it('checks capability without signing and ignores disabled or wrong-service capability',async()=>{
 for(const body of [{enabled:false},{enabled:true,version:1,service:'https://wrong.test'}]){fetcher.mockResolvedValueOnce(Response.json(body));expect(await inboundHistoryAvailable()).toBe(false);}
 fetcher.mockResolvedValueOnce(Response.json({enabled:true,version:1,service:INBOUND_HISTORY_SERVICE}));expect(await inboundHistoryAvailable()).toBe(true);expect(request).not.toHaveBeenCalled();
});
