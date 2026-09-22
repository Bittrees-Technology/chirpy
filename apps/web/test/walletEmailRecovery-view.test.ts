import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {WalletEmailRecovery} from '../src/views/WalletEmailRecovery';
import {I18nProvider} from '../src/i18n';
import {verifyRecoveryWallet} from '../src/recoveryWallet';
import {decryptWalletEmailArchive,encryptWalletEmailArchive} from '../src/walletEmailArchive';
import {download} from '../src/views/dialogs';
import {snapshotWalletEmailRecovery,walletEmailReceiptKey} from '../src/walletEmailReceipts';
vi.mock('../src/recoveryWallet',()=>({verifyRecoveryWallet:vi.fn()}));
vi.mock('../src/walletEmailArchive',async importOriginal=>({...await importOriginal<typeof import('../src/walletEmailArchive')>(),decryptWalletEmailArchive:vi.fn(),encryptWalletEmailArchive:vi.fn()}));
vi.mock('../src/views/dialogs',()=>({download:vi.fn()}));
const wallet='0x'+'1'.repeat(40),service='https://chat.example/api/mail',a='a'.repeat(32),b='b'.repeat(32),password='synthetic recovery passphrase';
let root:Root,container:HTMLDivElement,storage:Map<string,string>,dispose:ReturnType<typeof vi.fn>;
const key=walletEmailReceiptKey(wallet,service);
const data=()=>({version:1 as const,wallet,service,createdAt:1,active:a,ids:[a,b]});
const button=(name:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent===name)!;
const click=(name:string)=>act(async()=>button(name).click());
const waitFor=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});
const render=()=>act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(WalletEmailRecovery,{wallet,service})))));
const fill=async(confirm=true)=>act(async()=>{
 for(const input of [...container.querySelectorAll<HTMLInputElement>('input[type=password]')].slice(0,confirm?2:1)){
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,password);input.dispatchEvent(new Event('input',{bubbles:true}));
 }
});
const file=async(size=10)=>act(async()=>{
 const input=container.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(input,'files',{configurable:true,value:[{size,text:async()=>'encrypted'}]});input.dispatchEvent(new Event('change',{bubbles:true}));
});
const open=async()=>{await render();await act(async()=>{const details=container.querySelector('details')!;details.open=true;details.dispatchEvent(new Event('toggle'));});};
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);storage=new Map();
 vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)});
 dispose=vi.fn();vi.mocked(verifyRecoveryWallet).mockImplementation(async(_wallet,check)=>{check();return {assertCurrent:async()=>check(),assertSession:check,dispose};});
 vi.mocked(encryptWalletEmailArchive).mockResolvedValue('encrypted');vi.mocked(decryptWalletEmailArchive).mockResolvedValue(data());
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('requires review and fresh ownership proof before appending lookup-only IDs',async()=>{
 await open();await fill(false);await file();await click('Unlock and review request IDs');await waitFor(()=>expect(button('Restore request IDs')).toBeTruthy());
 expect(storage.has(key)).toBe(false);expect(verifyRecoveryWallet).toHaveBeenCalledTimes(1);expect([...container.querySelectorAll<HTMLInputElement>('input[type=password]')].every(i=>i.value==='')).toBe(true);
 await click('Restore request IDs');await waitFor(()=>expect(container.textContent).toContain('Request IDs restored'));
 expect(verifyRecoveryWallet).toHaveBeenCalledTimes(2);expect(snapshotWalletEmailRecovery(wallet,service).state.receipts).toEqual(data().ids.map(id=>({id,digest:null,createdAt:null})));expect(dispose).toHaveBeenCalledTimes(2);expect(download).not.toHaveBeenCalled();
});
it('refuses to apply when another tab changed the reviewed list',async()=>{
 await open();await fill(false);await file();await click('Unlock and review request IDs');await waitFor(()=>expect(button('Restore request IDs')).toBeTruthy());
 const raw=JSON.stringify({version:1,active:null,receipts:[{id:b,digest:null,createdAt:null}]});storage.set(key,raw);await click('Restore request IDs');await waitFor(()=>expect(container.textContent).toContain('Recovery could not finish'));
 expect(storage.get(key)).toBe(raw);
});
it('requires saved-backup acknowledgement, preserves the active ID and never claims a download is saved',async()=>{
 storage.set(key,JSON.stringify({version:1,active:a,receipts:data().ids.map(id=>({id,digest:null,createdAt:null}))}));
 vi.mocked(encryptWalletEmailArchive).mockImplementation(async value=>{vi.mocked(decryptWalletEmailArchive).mockResolvedValue(value);return 'encrypted';});
 await open();await fill();await click('Download encrypted request IDs');await waitFor(()=>expect(download).toHaveBeenCalledTimes(1));
 expect(container.textContent).toContain('download requested');expect(button('Remove backed-up older IDs').disabled).toBe(true);expect(snapshotWalletEmailRecovery(wallet,service).state.receipts).toHaveLength(2);
 await act(async()=>container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await click('Remove backed-up older IDs');await waitFor(()=>expect(container.textContent).toContain('IDs removed from this device'));
 expect(snapshotWalletEmailRecovery(wallet,service).state.receipts.map(r=>r.id)).toEqual([a]);expect(verifyRecoveryWallet).toHaveBeenCalledTimes(2);
});
it('rejects a backup that cannot be verified before download or cleanup',async()=>{
 await open();await fill();await click('Download encrypted request IDs');await waitFor(()=>expect(container.textContent).toContain('Recovery could not finish'));
 expect(download).not.toHaveBeenCalled();expect(button('Remove backed-up older IDs')).toBeUndefined();
});
it('does not export after an unmount while encryption is pending',async()=>{
 let resolve!:(value:string)=>void;vi.mocked(encryptWalletEmailArchive).mockImplementation(()=>new Promise(r=>resolve=r));
 await open();await fill();await click('Download encrypted request IDs');await waitFor(()=>expect(encryptWalletEmailArchive).toHaveBeenCalledTimes(1));
 vi.mocked(decryptWalletEmailArchive).mockResolvedValue(vi.mocked(encryptWalletEmailArchive).mock.calls[0][0]);
 await act(async()=>root.render(null));await act(async()=>resolve('encrypted'));expect(download).not.toHaveBeenCalled();expect(dispose).toHaveBeenCalled();
});
it('does not restore if ownership changes while the second wallet proof is pending',async()=>{
 await open();await fill(false);await file();await click('Unlock and review request IDs');await waitFor(()=>expect(button('Restore request IDs')).toBeTruthy());
 vi.mocked(verifyRecoveryWallet).mockRejectedValueOnce(Error('wallet changed'));await click('Restore request IDs');await waitFor(()=>expect(container.textContent).toContain('Recovery could not finish'));expect(storage.has(key)).toBe(false);
});
it('refuses oversized files without signing or parsing them',async()=>{
 await open();await fill(false);await file(16385);expect(button('Unlock and review request IDs').disabled).toBe(true);expect(container.textContent).toContain('exceeds the 16 KB');expect(verifyRecoveryWallet).not.toHaveBeenCalled();expect(decryptWalletEmailArchive).not.toHaveBeenCalled();
});
