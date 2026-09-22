import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {WalletEmail} from '../src/views/WalletEmail';
import {I18nProvider} from '../src/i18n';
import {clearActiveProvider,setActiveProvider} from '../src/walletProviders';
import {submitWalletEmail} from '../src/walletEmail';

const a='0x'+'1'.repeat(40),b='0x'+'2'.repeat(40);
const state=vi.hoisted(()=>({identity:{address:'0x'+'1'.repeat(40)},mode:'wallet'}));
vi.mock('../src/state',()=>({useIdentity:()=>state}));
vi.mock('../src/walletEmail',()=>({mailEndpoint:()=>({requestUrl:'/api/mail',service:'https://chat.example/api/mail'}),submitWalletEmail:vi.fn()}));
let root:Root,container:HTMLDivElement,storage:Map<string,string>;
const receiptKey=(wallet:string)=>'chirpy:mail-receipt:'+wallet;
const render=()=>act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(WalletEmail)))));
const button=(text:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent===text)!;
const click=(text:string)=>act(async()=>button(text).click());
const input=async(index:number,value:string)=>act(async()=>{
 const field=container.querySelectorAll('input')[index];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));
});
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);storage=new Map();
 vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({enabled:true,service:'https://chat.example/api/mail'})));
 state.identity={address:a};state.mode='wallet';setActiveProvider({request:async()=>[a]},'injected');
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();clearActiveProvider();vi.unstubAllGlobals();});
it('isolates saved receipts and clears private drafts when the wallet changes',async()=>{
 storage.set(receiptKey(a),'a'.repeat(32));storage.set(receiptKey(b),'b'.repeat(32));await render();await input(0,'private@example.com');await input(1,'Private subject');
 state.identity={address:b};await render();
 expect([...container.querySelectorAll('input')].map(i=>i.value)).toEqual(['','','b'.repeat(32)]);
 expect(storage.get(receiptKey(a))).toBe('a'.repeat(32));expect(storage.get(receiptKey(b))).toBe('b'.repeat(32));
 state.identity={address:a};await render();expect(container.querySelectorAll('input')[2].value).toBe('a'.repeat(32));
});
it.each(['mode','provider'])('cancels pending operations and clears drafts on %s changes for the same address',async(change)=>{
 storage.set(receiptKey(a),'a'.repeat(32));let resolve!:(value:any)=>void;
 vi.mocked(submitWalletEmail).mockImplementation(()=>new Promise(r=>resolve=r));
 await render();await input(1,'Private subject');await click('Check request status');
 const signal=vi.mocked(submitWalletEmail).mock.calls[0][1]!;expect(signal.aborted).toBe(false);
 if(change==='mode'){state.mode='local';await render();}else await act(async()=>setActiveProvider({request:async()=>[a]},'injected'));
 expect(signal.aborted).toBe(true);expect(container.querySelectorAll('input')[1].value).toBe('');
 await act(async()=>resolve({status:'accepted',id:'a'.repeat(32)}));
 expect(container.textContent).not.toContain('The email provider accepted');expect(storage.get(receiptKey(a))).toBe('a'.repeat(32));
});
it('retains a submitted request ID after leaving and reopening the screen without repeating a send',async()=>{
 vi.mocked(submitWalletEmail).mockImplementation(()=>new Promise(()=>{}));await render();await input(0,'fixture@example.com');await input(1,'Fixture');
 await act(async()=>{const field=container.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,'Test body');field.dispatchEvent(new Event('input',{bubbles:true}));});
 await click('Sign and queue email');const [command,signal]=vi.mocked(submitWalletEmail).mock.calls[0];
 expect(storage.get(receiptKey(a))).toBe(command.id);
 await act(async()=>root.render(null));expect(signal!.aborted).toBe(true);await render();
 expect(container.querySelectorAll('input')[2].value).toBe(command.id);expect(button('Sign and queue email').disabled).toBe(true);
 expect(submitWalletEmail).toHaveBeenCalledTimes(1);
});
