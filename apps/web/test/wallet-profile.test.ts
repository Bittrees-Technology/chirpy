import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { IdentityProvider, useIdentity } from '../src/state';
import { walletProfileKey, walletLabel, PROFILE_SAVE_ERROR, PROFILE_LABEL_ERROR } from '../src/walletProfile';
const a = '0x000000000000000000000000000000000000000a';
const b = '0x000000000000000000000000000000000000000b';
const mock = vi.hoisted(() => ({ account: '', handlers: new Map<string, Function>(), ens: vi.fn() }));
vi.mock('../src/ens', () => ({ resolveEns: (...args) => mock.ens(...args) }));
vi.mock('../src/walletProviders', () => {
  const provider = { request: async () => [mock.account], on: (event, cb) => mock.handlers.set(event, cb), removeListener: (event) => mock.handlers.delete(event) };
  return { getInjectedEthereum: () => provider, getActiveProvider: () => provider, getActiveKind: () => 'injected', setActiveProvider: () => {}, clearActiveProvider: () => {}, walletConnectAvailable: () => false, restoreWalletConnect: async () => null };
});
afterEach(() => { vi.unstubAllGlobals(); mock.handlers.clear(); });
async function fixture(){
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mock.account = a;
  const storage = new Map<string,string>(); let deny = false;
  vi.stubGlobal('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key,value) => { if(deny) throw Error('quota'); storage.set(key,value); }, removeItem: key => { if(deny) throw Error('blocked'); storage.delete(key); } });
  const lookups: Array<(value:any)=>void> = [];
  mock.ens.mockImplementation(() => new Promise(resolve => lookups.push(resolve)));
  let current: ReturnType<typeof useIdentity>;
  function Probe(){ current = useIdentity(); return null; }
  let root = createRoot(document.createElement('div'));
  async function mount(){ await act(async () => root.render(React.createElement(IdentityProvider,null,React.createElement(Probe)))); }
  await mount();
  return { storage, lookups, get current(){return current!;}, deny(){deny=true;}, async connect(){await act(async()=>{void current!.connectWallet();});}, async switch(address:string){await act(async()=>{mock.account=address;mock.handlers.get('accountsChanged')?.([address]);});}, async reload(){await act(async()=>root.unmount());root=createRoot(document.createElement('div'));await mount();}, async close(){await act(async()=>root.unmount());} };
}
it('retains explicit labels and blank choices across delayed ENS, wallet changes and reload; reset restores ENS',async()=>{
 const f=await fixture();
 try{
  await f.connect();
  await act(async()=>f.current.setHandle('Chosen name'));
  await act(async()=>f.lookups[0]({name:'a.eth',displayName:'ENS name'}));
  expect(f.current.identity.handle).toBe('Chosen name');
  await f.switch(b);
  expect(f.current.identity.handle).toBeUndefined();
  await act(async()=>f.current.setHandle(''));
  await act(async()=>f.lookups[1]({name:'b.eth'}));
  expect(f.current.identity.handle).toBe('');
  await f.switch(a.toUpperCase().replace('0X','0x'));
  expect(f.current.identity.handle).toBe('Chosen name');
  await f.reload();
  expect(f.current.identity.handle).toBe('Chosen name');
  await act(async()=>f.lookups.at(-1)!({name:'a.eth'}));
  await act(async()=>f.current.resetHandle());
  expect(f.current.identity.handle).toBe('a.eth');
  expect(f.storage.has(walletProfileKey(a))).toBe(false);
  await f.switch(b);
  expect(f.current.identity.handle).toBe('');
  await act(async()=>f.current.disconnectWallet());
  expect(f.current.identity.handle).toBe('you');
 }finally{await f.close();}
});
it('rejects invalid labels and reports failed persistence without changing the saved choice',async()=>{
 const f=await fixture();
 try{
  await f.connect();await act(async()=>f.current.setHandle('Saved'));
  for(const invalid of ['x'.repeat(81),'spoof\u202eeth','line\nfeed']){
   await act(async()=>f.current.setHandle(invalid));
   expect(f.current.walletError).toBe(PROFILE_LABEL_ERROR);expect(f.current.identity.handle).toBe('Saved');
  }
  f.deny();await act(async()=>f.current.setHandle('Unsaved'));
  expect(f.current.walletError).toBe(PROFILE_SAVE_ERROR);expect(f.current.identity.handle).toBe('Saved');
  await act(async()=>f.current.resetHandle());expect(f.current.walletError).toBe(PROFILE_SAVE_ERROR);
  await act(async()=>f.lookups[0]({name:'late.eth'}));expect(f.current.identity.handle).toBe('Saved');
  expect(JSON.parse(f.storage.get(walletProfileKey(a))!)).toBe('Saved');
  f.storage.set(walletProfileKey(b),'{invalid');expect(walletLabel(b)).toBe('');
  f.storage.set(walletProfileKey(b),JSON.stringify({name:'bad'}));expect(walletLabel(b)).toBe('');
 }finally{await f.close();}
});
