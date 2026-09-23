import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readPublicProfiles,publishPublicProfile} from '../src/publicProfiles';
import {setActiveProvider,clearActiveProvider} from '../src/walletProviders';
import {publicName} from '../src/usePublicProfiles';
const wallet='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40),service='https://chat.example/api/profile';
vi.mock('../src/apiEndpoint',()=>({syncEndpoint:()=>({service:'https://chat.example/api/usersync',requestUrl:'/api/usersync'})}));
let provider:any,handlers:Map<string,()=>void>;
const profile=(label:string|null='Chosen')=>({version:1 as const,wallet,revision:1,label,updatedAt:1});
beforeEach(()=>{
 handlers=new Map();provider={request:vi.fn(async({method})=>method==='eth_accounts'?[wallet]:'0x1234'),on:(event,fn)=>handlers.set(event,fn),removeListener:vi.fn()};setActiveProvider(provider,'injected');
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>init?.method==='POST'?Response.json({service,status:'saved',profile:profile()}):Response.json({service,profiles:[profile()]})));
});
afterEach(()=>{clearActiveProvider();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('binds publication to the active wallet and exact public-profile service and never sends cookies',async()=>{
 expect(await publishPublicProfile(wallet,0,'Chosen',new AbortController().signal)).toEqual(profile());
 const init=vi.mocked(fetch).mock.calls[0][1]!;expect(init.credentials).toBe('omit');expect(init.redirect).toBe('error');const {command}=JSON.parse(init.body as string);expect(command).toMatchObject({wallet,service,revision:0,label:'Chosen'});expect(provider.removeListener).toHaveBeenCalledTimes(3);
});
it.each(['wallet','provider','disconnect'])('does not publish after %s changes during signing',async(change)=>{
 let done!:(value:string)=>void;provider.request.mockImplementation(async({method})=>method==='eth_accounts'?[wallet]:new Promise(resolve=>done=resolve));
 const result=publishPublicProfile(wallet,0,'Chosen',new AbortController().signal);await vi.waitFor(()=>expect(done).toBeTypeOf('function'));
 if(change==='wallet')provider.request.mockResolvedValue([other]);else if(change==='provider')setActiveProvider({request:async()=>[wallet]},'injected');else handlers.get('disconnect')!();
 done('0x1234');await expect(result).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('ignores a late response after cancellation without announcing success',async()=>{
 let done!:(r:Response)=>void;vi.mocked(fetch).mockImplementation(()=>new Promise(resolve=>done=resolve));const controller=new AbortController(),result=publishPublicProfile(wallet,0,'Chosen',controller.signal);
 await vi.waitFor(()=>expect(done).toBeTypeOf('function'));controller.abort();done(Response.json({service,status:'saved',profile:profile()}));await expect(result).rejects.toThrow();
});
it('rejects mismatched response identities, revisions, labels, unknown fields and oversized streams',async()=>{
 for(const patch of [{wallet:other},{revision:2},{label:'Changed'},{email:'private@example.com'}]){
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({service,status:'saved',profile:{...profile(),...patch}}));await expect(publishPublicProfile(wallet,0,'Chosen',new AbortController().signal)).rejects.toThrow();
 }
 vi.mocked(fetch).mockResolvedValueOnce(new Response(' '.repeat(40001)));await expect(readPublicProfiles([wallet])).rejects.toThrow();
 vi.mocked(fetch).mockResolvedValueOnce(Response.json({service:'https://wrong.example/api/profile',profiles:[profile()]}));await expect(readPublicProfiles([wallet])).rejects.toThrow();
});
it('reads bounded ordered public profiles without accepting cross-wallet substitutions',async()=>{
 expect(await readPublicProfiles([wallet])).toEqual([profile()]);await expect(readPublicProfiles([wallet,wallet])).rejects.toThrow();
 vi.mocked(fetch).mockResolvedValueOnce(Response.json({service,profiles:[{...profile(),wallet:other}]}));await expect(readPublicProfiles([wallet])).rejects.toThrow();
});
it('public choice overrides old labels and ENS, withdrawal or unknown state displays only the wallet',()=>{
 const ens={name:'old.eth',avatar:'https://example.com/a'};
 expect(publicName(wallet,profile(),ens,'Old local title',true)).toBe('Chosen');
 for(const p of [profile(null),undefined])expect(publicName(wallet,p,ens,'Old title',true)).toBe('0x1111…1111');
 expect(publicName(wallet,{...profile(null),revision:0,updatedAt:0},ens,'Local title',true)).toBe('Local title');
});
