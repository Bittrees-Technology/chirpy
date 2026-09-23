import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {WalletEmailDiscovery} from '../src/views/WalletEmailDiscovery';
import {I18nProvider} from '../src/i18n';
import {verifyRecoveryWallet} from '../src/recoveryWallet';
import {discoverWalletEmail} from '../src/walletEmail';
import {snapshotWalletEmailRecovery,walletEmailReceiptKey} from '../src/walletEmailReceipts';
vi.mock('../src/recoveryWallet',()=>({verifyRecoveryWallet:vi.fn()}));
vi.mock('../src/walletEmail',()=>({discoverWalletEmail:vi.fn()}));
const wallet='0x'+'1'.repeat(40),service='https://chat.example/api/mail',a='a'.repeat(32),b='b'.repeat(32),cursor='f'.repeat(64);
let root:Root,container:HTMLDivElement,storage:Map<string,string>,dispose:ReturnType<typeof vi.fn>;
const key=walletEmailReceiptKey(wallet,service);
const button=(name:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent===name)!;
const click=(name:string)=>act(async()=>button(name).click());
const waitFor=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});
const render=(session='first')=>act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(WalletEmailDiscovery,{key:session,wallet,service})))));
const find=async()=>{await render();await click('Find recent requests');await waitFor(()=>expect(button('Save these request IDs')).toBeTruthy());};
const saved=()=>snapshotWalletEmailRecovery(wallet,service).state;
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);storage=new Map();
 vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)});
 dispose=vi.fn();vi.mocked(verifyRecoveryWallet).mockImplementation(async(_wallet,check)=>{check();return {assertCurrent:async()=>check(),assertSession:check,dispose};});
 vi.mocked(discoverWalletEmail).mockResolvedValue({ids:[a,b],nextCursor:null});
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('reviews without writes and requires fresh ownership before restoring lookup-only IDs',async()=>{
 await find();expect(storage.has(key)).toBe(false);expect(verifyRecoveryWallet).not.toHaveBeenCalled();
 await click('Save these request IDs');await waitFor(()=>expect(container.textContent).toContain('Request IDs saved'));
 expect(saved()).toEqual({version:1,active:a,receipts:[a,b].map(id=>({id,digest:null,createdAt:null}))});expect(dispose).toHaveBeenCalledOnce();expect(button('Save these request IDs').disabled).toBe(true);
});
it('preserves an existing active request and its retry evidence',async()=>{
 const active={id:'c'.repeat(32),digest:'d'.repeat(64),createdAt:1};storage.set(key,JSON.stringify({version:1,active:active.id,receipts:[active]}));
 await find();await click('Save these request IDs');await waitFor(()=>expect(saved().receipts).toHaveLength(3));expect(saved().active).toBe(active.id);expect(saved().receipts[0]).toEqual(active);
});
it('rejects a changed local list after review without overwriting it',async()=>{
 await find();const changed=JSON.stringify({version:1,active:b,receipts:[{id:b,digest:null,createdAt:null}]});storage.set(key,changed);
 await click('Save these request IDs');await waitFor(()=>expect(container.textContent).toContain('Recovery could not finish'));expect(storage.get(key)).toBe(changed);
});
it('does not evict IDs to fit a recovered page at capacity',async()=>{
 const receipts=Array.from({length:100},(_,i)=>({id:i.toString(16).padStart(32,'0'),digest:null,createdAt:null}));const original=JSON.stringify({version:1,active:receipts[0].id,receipts});storage.set(key,original);
 await find();expect(container.textContent).toContain('100 saved-ID limit');expect(button('Save these request IDs').disabled).toBe(true);expect(storage.get(key)).toBe(original);expect(verifyRecoveryWallet).not.toHaveBeenCalled();
});
it('requests separate signed pages and rejects pagination cycles without retaining a stale review',async()=>{
 vi.mocked(discoverWalletEmail).mockResolvedValueOnce({ids:[a],nextCursor:cursor});await find();
 vi.mocked(discoverWalletEmail).mockResolvedValueOnce({ids:[b],nextCursor:null});await click('Older requests');await waitFor(()=>expect(container.querySelector('code')!.textContent).toBe(b));
 expect(vi.mocked(discoverWalletEmail).mock.calls[1][0]).toMatchObject({cursor});
 vi.mocked(discoverWalletEmail).mockResolvedValueOnce({ids:[a],nextCursor:cursor});await click('Newer requests');expect(vi.mocked(discoverWalletEmail).mock.calls[2][0]).toMatchObject({cursor:null});
 vi.mocked(discoverWalletEmail).mockResolvedValueOnce({ids:[b],nextCursor:cursor});await click('Older requests');await waitFor(()=>expect(container.textContent).toContain('Recovery could not finish'));expect(button('Save these request IDs')).toBeUndefined();expect(storage.has(key)).toBe(false);
});
it('labels an empty page without treating it as proof that no mail was sent',async()=>{
 vi.mocked(discoverWalletEmail).mockResolvedValueOnce({ids:[],nextCursor:null});await find();expect(container.textContent).toContain('not proof');expect(button('Save these request IDs').disabled).toBe(true);expect(storage.has(key)).toBe(false);
});
it('aborts pending lookup on provider replacement and drops late results',async()=>{
 let resolve!:(value:any)=>void;vi.mocked(discoverWalletEmail).mockImplementationOnce(()=>new Promise(r=>resolve=r));await render();await click('Find recent requests');
 const signal=vi.mocked(discoverWalletEmail).mock.calls[0][1]!;await render('replacement');expect(signal.aborted).toBe(true);await act(async()=>resolve({ids:[a],nextCursor:null}));expect(container.querySelector('code')).toBeNull();expect(storage.has(key)).toBe(false);
});
it('does not restore after a provider change while ownership proof is pending',async()=>{
 await find();let resolve!:(value:any)=>void;vi.mocked(verifyRecoveryWallet).mockImplementationOnce(()=>new Promise(r=>resolve=r));await click('Save these request IDs');await render('replacement');
 await act(async()=>resolve({assertCurrent:async()=>{},assertSession:()=>{},dispose}));expect(storage.has(key)).toBe(false);expect(dispose).toHaveBeenCalledOnce();
});
