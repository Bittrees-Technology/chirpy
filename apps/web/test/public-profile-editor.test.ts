import React,{act} from 'react';import {createRoot,type Root} from 'react-dom/client';import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {PublicProfile} from '../src/views/PublicProfile';import {I18nProvider} from '../src/i18n';import {readPublicProfiles,publishPublicProfile} from '../src/publicProfiles';import {setActiveProvider,clearActiveProvider} from '../src/walletProviders';
const state=vi.hoisted(()=>({identity:{address:'0x'+'1'.repeat(40)},mode:'wallet'}));
vi.mock('../src/state',()=>({useIdentity:()=>state}));vi.mock('../src/publicProfiles',()=>({readPublicProfiles:vi.fn(),publishPublicProfile:vi.fn()}));
const a='0x'+'1'.repeat(40),b='0x'+'2'.repeat(40);const profile=(wallet=a)=>({version:1 as const,wallet,revision:0,label:null,updatedAt:0});
let root:Root,container:HTMLDivElement;
const button=(text:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent===text)!;
const render=()=>act(async()=>root.render(React.createElement(I18nProvider,null,React.createElement(PublicProfile))));
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);state.identity={address:a};setActiveProvider({request:async()=>[a]},'injected');vi.mocked(readPublicProfiles).mockResolvedValue([profile()]);container=document.createElement('div');root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());clearActiveProvider();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('never signs on load or without explicit confirmation and requires reload after an uncertain save',async()=>{
 await render();expect(publishPublicProfile).not.toHaveBeenCalled();expect(button('Sign and use wallet address').disabled).toBe(true);
 await act(async()=>container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());vi.mocked(publishPublicProfile).mockRejectedValueOnce(Error('ack lost'));await act(async()=>button('Sign and use wallet address').click());
 expect(container.textContent).toContain('a previous update may already have been saved');expect(button('Sign and use wallet address').disabled).toBe(true);expect(publishPublicProfile).toHaveBeenCalledTimes(1);
 await act(async()=>button('Reload public profile').click());expect(button('Sign and use wallet address').disabled).toBe(true);expect(publishPublicProfile).toHaveBeenCalledTimes(1);
});
it('discards another wallet read and its confirmation on account changes',async()=>{
 let first!:(value:any)=>void;vi.mocked(readPublicProfiles).mockImplementationOnce(()=>new Promise(r=>first=r));await render();const signal=vi.mocked(readPublicProfiles).mock.calls[0][1]!;
 state.identity={address:b};vi.mocked(readPublicProfiles).mockResolvedValueOnce([profile(b)]);await render();expect(signal.aborted).toBe(true);await act(async()=>first([{...profile(),revision:1,label:'Old account',updatedAt:1}]));expect(container.textContent).not.toContain('Old account');expect(container.textContent).toContain(b);expect(publishPublicProfile).not.toHaveBeenCalled();
});
it('aborts a pending publication on provider replacement and ignores a late successful response',async()=>{
 await render();let finish!:(value:any)=>void;vi.mocked(publishPublicProfile).mockImplementationOnce(()=>new Promise(r=>finish=r));await act(async()=>container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await act(async()=>button('Sign and use wallet address').click());const signal=vi.mocked(publishPublicProfile).mock.calls[0][3];
 await act(async()=>setActiveProvider({request:async()=>[a]},'injected'));expect(signal.aborted).toBe(true);await act(async()=>finish({...profile(),revision:1,updatedAt:1}));expect(container.textContent).not.toContain('Chat name withdrawn.');
});
