import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { IdentityProvider, SettingsPrefsProvider, useIdentity, useSettingsPrefs } from "../src/state";

const mocks = vi.hoisted(() => ({
  address: "0x0000000000000000000000000000000000000001",
  pull: vi.fn(), push: vi.fn(), authorize: vi.fn(), revoke: vi.fn(), revokeAll: vi.fn(),
}));
vi.mock("../src/ens", () => ({ resolveEns: async () => null }));
vi.mock("../src/walletProviders", () => {
  const provider = {
    request: async ({ method }) => method === "personal_sign" ? "0x" + "11".repeat(65) : [mocks.address],
    on: () => {}, removeListener: () => {},
  };
  return { getInjectedEthereum: () => provider, getActiveProvider: () => provider, getActiveKind: () => "injected", setActiveProvider: () => {}, clearActiveProvider: () => {}, walletConnectAvailable: () => false, restoreWalletConnect: async () => null };
});
vi.mock("../src/userSync", async (original) => ({
  ...await original<typeof import("../src/userSync")>(),
  pullRemoteBlob: (...args) => mocks.pull(...args),
  pushBlob: (...args) => mocks.push(...args),
  createSyncAuthorization: (...args) => mocks.authorize(...args),
  revokeSyncAuthorization: (...args) => mocks.revoke(...args),
  revokeAllSyncAuthorizations: (...args) => mocks.revokeAll(...args),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function encrypted(payload: unknown) {
 const raw=await webcrypto.subtle.importKey('raw',new Uint8Array(65).fill(17),'HKDF',false,['deriveKey']);
 const key=await webcrypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode(`Chirpy encrypted sync v1:${mocks.address}`),info:new TextEncoder().encode('settings-prefs-and-saved-messages')},raw,{name:'AES-GCM',length:256},false,['encrypt']);
 const iv=webcrypto.getRandomValues(new Uint8Array(12));
 const ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(payload)));
 return {version:1,algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address:mocks.address,iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(ciphertext).toString('base64'),updatedAt:10};
}
const valid=()=>({version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[]},savedMessages:[{id:'legacy',body:'Keep this note',custom:{original:true}}],updatedAt:10});

for(const stage of ['enable','active'] as const)for(const kind of ['future','corrupt'] as const)it(`preserves ${kind} remote data during ${stage} and stops later writes`,async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.stubGlobal('crypto',webcrypto);
 const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)});
 const fixture=await encrypted({...valid(),...(kind==='future'?{version:2,tombstones:['legacy']}:{})});
 if(kind==='corrupt')fixture.ciphertext='AAAA';
 const before=JSON.stringify(fixture);
 mocks.authorize.mockReset().mockResolvedValue({grant:{expiresAt:Date.now()+60000}});
 mocks.pull.mockReset().mockResolvedValue(stage==='enable'?fixture:null);
 mocks.push.mockReset().mockResolvedValue({ok:true});
 let current:any;function Probe(){current={...useIdentity(),...useSettingsPrefs()};return null;}
 const root=createRoot(document.createElement('div'));
 try{
  await act(async()=>root.render(React.createElement(IdentityProvider,null,React.createElement(SettingsPrefsProvider,null,React.createElement(Probe)))));
  await act(async()=>current.connectWallet());
  const prefsKey=`chat:settingsPrefs:v1:wallet:${mocks.address}`;
  if(stage==='enable'){
   let result:any;await act(async()=>{result=await current.enableSyncAcrossDevices();});
   expect(result.ok).toBe(false);expect(mocks.push).not.toHaveBeenCalled();
  }else{
   await act(async()=>{expect((await current.enableSyncAcrossDevices()).ok).toBe(true);});
   // Drain the initial session read before introducing a different device's blob.
   await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
   mocks.pull.mockResolvedValue(fixture);mocks.push.mockResolvedValue({ok:false,stale:true});
   await act(async()=>current.setReadReceiptsDefault(true));
   await vi.waitFor(async()=>{await act(async()=>{});expect(current.syncState.error).toBeTruthy();},{timeout:4000});
  }
  expect(current.syncState.hasSessionKey).toBe(false);
  const writes=mocks.push.mock.calls.length;
  await act(async()=>current.setReadReceiptsDefault(false));
  await act(async()=>current.setChatReadReceipts('dm',false));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1800));});
  expect(mocks.push.mock.calls.length).toBe(writes);
  expect(JSON.stringify(fixture)).toBe(before);
  expect(JSON.parse(storage.get(prefsKey)!).readReceiptsDefault).toBe(false);
  expect(Object.values(current.prefs.readReceiptOverrides)).toEqual([false]);
  // Re-enablement must reread; only a compatible, decryptable snapshot can resume.
  mocks.pull.mockResolvedValue(await encrypted(valid()));mocks.push.mockResolvedValue({ok:true});
  await act(async()=>{expect((await current.enableSyncAcrossDevices()).ok).toBe(true);});
  expect(current.syncState.hasSessionKey).toBe(true);
 }finally{await act(async()=>root.unmount());}
},10000);
