import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {WalletEmail} from '../src/views/WalletEmail';
import {I18nProvider} from '../src/i18n';
import {clearActiveProvider,setActiveProvider} from '../src/walletProviders';
import {submitWalletEmail} from '../src/walletEmail';
import {readWalletEmailRecovery,reserveWalletEmailReceipt,walletEmailReceiptKey} from '../src/walletEmailReceipts';

const a='0x'+'1'.repeat(40),b='0x'+'2'.repeat(40);
const state=vi.hoisted(()=>({identity:{address:'0x'+'1'.repeat(40)},mode:'wallet'}));
vi.mock('../src/state',()=>({useIdentity:()=>state}));
vi.mock('../src/walletEmail',()=>({mailEndpoint:()=>({requestUrl:'/api/mail',service:'https://chat.example/api/mail'}),submitWalletEmail:vi.fn()}));
let root:Root,container:HTMLDivElement,storage:Map<string,string>;
const receiptKey=(wallet:string)=>'chirpy:mail-receipt:'+wallet;
const render=()=>act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(WalletEmail)))));
const button=(text:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent===text)!;
const click=(text:string)=>act(async()=>button(text).click());
const waitFor=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});
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
afterEach(async()=>{await act(async()=>root.unmount());container.remove();clearActiveProvider();vi.unstubAllGlobals();vi.restoreAllMocks();});
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
 await click('Sign and queue email');await waitFor(()=>expect(submitWalletEmail).toHaveBeenCalledTimes(1));const [command,signal]=vi.mocked(submitWalletEmail).mock.calls[0];
 expect(readWalletEmailRecovery(a,command.service).active).toBe(command.id);
 await act(async()=>root.render(null));expect(signal!.aborted).toBe(true);await render();
 expect(container.querySelectorAll('input')[2].value).toBe(command.id);expect(button('Sign and queue email').disabled).toBe(true);
 expect(submitWalletEmail).toHaveBeenCalledTimes(1);
});
const fillDraft=async()=>{
 await input(0,'fixture@example.com');await input(1,'Fixture');
 await act(async()=>{const field=container.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,'Test body');field.dispatchEvent(new Event('input',{bubbles:true}));});
};
it('does not open signing when storage fails, and leaves a malformed legacy ID untouched',async()=>{
 await render();await fillDraft();
 const set=vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('full');});
 await click('Sign and queue email');await waitFor(()=>expect(container.textContent).toContain('could not safely reserve'));expect(submitWalletEmail).not.toHaveBeenCalled();
 set.mockRestore();storage.set(receiptKey(a),'legacy-invalid');await click('Check recovery storage');
 expect(button('Sign and queue email').disabled).toBe(true);expect(storage.get(receiptKey(a))).toBe('legacy-invalid');
});
it('retains earlier IDs when a new message is started and can check history without changing the active receipt',async()=>{
 const digest=crypto.subtle.digest.bind(crypto.subtle);
 vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{await new Promise(resolve=>setTimeout(resolve,25));return digest(...args);});
 vi.mocked(submitWalletEmail).mockImplementation(async c=>({id:c.id,status:'accepted'}));
 await render();await fillDraft();await click('Sign and queue email');await waitFor(()=>expect(submitWalletEmail).toHaveBeenCalledTimes(1));const first=vi.mocked(submitWalletEmail).mock.calls[0][0];
 await click('New message');expect(readWalletEmailRecovery(a,first.service).active).toBeNull();
 await fillDraft();await click('Sign and queue email');await waitFor(()=>expect(submitWalletEmail).toHaveBeenCalledTimes(2));const second=vi.mocked(submitWalletEmail).mock.calls[1][0];expect(second.id).not.toBe(first.id);
 const state=readWalletEmailRecovery(a,first.service);expect(state.receipts.map(r=>r.id)).toEqual([first.id,second.id]);
 const history=container.querySelector('details li')!;await act(async()=>history.querySelector('button')!.click());
 expect(vi.mocked(submitWalletEmail).mock.calls.at(-1)![0]).toMatchObject({action:'status',id:first.id});
 expect(readWalletEmailRecovery(a,first.service).active).toBe(second.id);expect(container.querySelectorAll('input')[2].value).toBe(second.id);
});
it('picks up another tab reservation and never overwrites it by editing the displayed request ID',async()=>{
 await render();await fillDraft();
 const other={action:'send' as const,wallet:a,service:'https://chat.example/api/mail',id:'d'.repeat(32),to:'other@example.com',subject:'Other',text:'Other body',expiresAt:Date.now()+60000};
 await act(async()=>reserveWalletEmailReceipt(other,false));
 expect(container.querySelectorAll('input')[2].value).toBe(other.id);expect(container.querySelectorAll('input')[2].disabled).toBe(true);
 expect(button('Sign and queue email').disabled).toBe(true);expect(submitWalletEmail).not.toHaveBeenCalled();
 const raw=storage.get(walletEmailReceiptKey(a,other.service));
 await act(async()=>window.dispatchEvent(new StorageEvent('storage',{key:walletEmailReceiptKey(a,other.service)})));
 expect(storage.get(walletEmailReceiptKey(a,other.service))).toBe(raw);
});
it('stops an expired retry before opening another signature while keeping its ID for lookup',async()=>{
 vi.mocked(submitWalletEmail).mockRejectedValue(Error('uncertain'));
 await render();await fillDraft();await click('Sign and queue email');await waitFor(()=>expect(submitWalletEmail).toHaveBeenCalledTimes(1));
 const command=vi.mocked(submitWalletEmail).mock.calls[0][0],createdAt=readWalletEmailRecovery(a,command.service).receipts[0].createdAt!;
 vi.spyOn(Date,'now').mockReturnValue(createdAt+23*3600000);
 await click('Retry same request');await waitFor(()=>expect(container.textContent).toContain('too old to retry safely'));expect(submitWalletEmail).toHaveBeenCalledTimes(1);
 expect(container.querySelectorAll('input')[2].value).toBe(command.id);expect(button('Check request status').disabled).toBe(false);
});

const seedHistory=()=>{
 const ids=['a'.repeat(32),'b'.repeat(32)];storage.set(walletEmailReceiptKey(a,'https://chat.example/api/mail'),JSON.stringify({version:1,active:ids[0],receipts:ids.map(id=>({id,digest:null,createdAt:null}))}));return ids;
};
const receiptDetails={version:1 as const,createdAt:1700000000000,updatedAt:1700000001000,attempts:2,retryUntil:1700082800000};
it('keeps separate checked histories, stores no observations and preserves the active recovery ID',async()=>{
 const ids=seedHistory(),before=storage.get(walletEmailReceiptKey(a,'https://chat.example/api/mail'));
 vi.mocked(submitWalletEmail).mockImplementation(async c=>({id:c.id,status:c.id===ids[0]?'accepted':'stopped',receipt:receiptDetails}));await render();
 const rows=container.querySelectorAll('.wallet-email-history li');
 for(const row of rows)await act(async()=>row.querySelector('button')!.click());
 expect(rows[0].textContent).toContain('does not confirm delivery or reading');expect(rows[1].textContent).toContain('Forwarding stopped');
 for(const row of rows){expect(row.textContent).toContain('Processing attempts');expect(row.querySelector('time')?.dateTime).toBeTruthy();}
 expect(storage.get(walletEmailReceiptKey(a,'https://chat.example/api/mail'))).toBe(before);expect(container.querySelectorAll('input')[2].value).toBe(ids[0]);
});
it('a failed recheck removes previous receipt details without changing another request result',async()=>{
 const ids=seedHistory();vi.mocked(submitWalletEmail).mockImplementation(async c=>({id:c.id,status:'accepted',receipt:receiptDetails}));await render();
 const rows=container.querySelectorAll('.wallet-email-history li');for(const row of rows)await act(async()=>row.querySelector('button')!.click());
 vi.mocked(submitWalletEmail).mockRejectedValueOnce(Error('offline'));await act(async()=>rows[1].querySelector('button')!.click());
 expect(rows[0].textContent).toContain('Processing attempts');expect(rows[1].querySelector('dl')).toBeNull();expect(rows[1].querySelector('[role=alert]')).not.toBeNull();expect(readWalletEmailRecovery(a,'https://chat.example/api/mail').active).toBe(ids[0]);
});
it('explains unknown evidence and clears checked observations when the provider reconnects',async()=>{
 seedHistory();vi.mocked(submitWalletEmail).mockImplementation(async c=>({id:c.id,status:'unknown'}));await render();
 await act(async()=>container.querySelector('.wallet-email-history li button')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
 expect(container.textContent).toContain('does not prove that the email was never sent');
 await act(async()=>setActiveProvider({request:async()=>[a]},'injected'));expect(container.textContent).not.toContain('does not prove that the email was never sent');expect(container.querySelector('.wallet-email-history time')).toBeNull();
});

it('shows independent provider facts without claiming reading and clears stale facts on recheck failure',async()=>{
 const ids=seedHistory(),key=walletEmailReceiptKey(a,'https://chat.example/api/mail'),original=storage.get(key);
 vi.mocked(submitWalletEmail).mockImplementation(async c=>({id:c.id,status:'accepted',receipt:receiptDetails,delivery:{version:1,events:[{type:'delivered',occurredAt:1700000000000},{type:'bounced',occurredAt:1700000001000}]}}));await render();
 const row=container.querySelector('.wallet-email-history li')!;await act(async()=>row.querySelector('button')!.click());
 expect(row.textContent).toContain('Recipient mail server accepted');expect(row.textContent).toContain('Recipient mail server rejected');expect(row.textContent).toContain('does not prove inbox placement or reading');expect(storage.get(key)).toBe(original);
 vi.mocked(submitWalletEmail).mockRejectedValueOnce(Error('offline'));await act(async()=>row.querySelector('button')!.click());expect(row.querySelector('.wallet-email-delivery')).toBeNull();expect(storage.get(key)).toBe(original);
});

it('holds a server-uncertain request across failed lookups without enabling another send',async()=>{
 vi.mocked(submitWalletEmail).mockImplementation(async c=>({id:c.id,status:'uncertain'}));
 await render();await fillDraft();await click('Sign and queue email');
 await waitFor(()=>expect(container.textContent).toContain('Automatic retries are paused'));
 const command=vi.mocked(submitWalletEmail).mock.calls[0][0];
 expect(button('Retry same request').disabled).toBe(true);
 expect(button('Check request status').disabled).toBe(false);
 vi.mocked(submitWalletEmail).mockRejectedValue(Error('connection lost'));
 await click('Check request status');
 expect(container.textContent).toContain('Automatic retries are paused');
 expect(button('Retry same request').disabled).toBe(true);
 expect(readWalletEmailRecovery(a,command.service).active).toBe(command.id);
 // Clearing the composer is explicit and keeps the held ID in recovery history.
 await click('New message');
 expect(readWalletEmailRecovery(a,command.service).receipts.map(r=>r.id)).toContain(command.id);
 expect(readWalletEmailRecovery(a,command.service).active).toBeNull();
 expect(vi.mocked(submitWalletEmail).mock.calls.map(([c])=>c.action)).toEqual(['send','status']);
});
