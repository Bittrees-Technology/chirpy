import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress, keccak256, stringToHex } from 'viem';
import { syncGrantMessage, syncWriteMessage } from '@app/core';
import { authorizeVersionedSync as authorize, decryptVersionedSync as decrypt, readVersionedSync as read, writeVersionedSync as write } from '../src/versionedSyncTransport';
import { encryptSyncPayloadV2 } from '../src/versionedSyncCipher';
import { editSyncPayloadV2, upgradeSyncPayloadV1 } from '../src/versionedSync';
const wallet=privateKeyToAccount(('0x'+'12'.repeat(32)) as `0x${string}`),address=wallet.address.toLowerCase();
const service=()=>new URL('/api/usersync',window.location.href).href;
const guard=()=>{};
const body=(patch={})=>({blob:null,revision:0,epoch:0,authVersion:2,service:service(),payloadVersions:[1,2],minPayloadVersion:1,...patch});
const response=(value:unknown,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});
const legacy=()=>({version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[]},savedMessages:[{id:'keep',body:'legacy'}],updatedAt:10});
let key:CryptoKey,env:Awaited<ReturnType<typeof encryptSyncPayloadV2>>;
beforeEach(async()=>{vi.stubGlobal('crypto',webcrypto);key=await webcrypto.subtle.importKey('raw',new Uint8Array(32).fill(3),'AES-GCM',false,['encrypt','decrypt']);env=await encryptSyncPayloadV2(upgradeSyncPayloadV1(legacy()),key,address);});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('reads the advertised empty state, signs the existing device protocol, then requires acknowledgement and an authoritative reread',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(body())).mockResolvedValueOnce(response({ok:true,revision:1,minPayloadVersion:2})).mockResolvedValueOnce(response(body({blob:JSON.stringify(env),revision:1,minPayloadVersion:2})));
 vi.stubGlobal('fetch',fetcher);const initial=await read(address,1,guard);expect(await decrypt(initial,key)).toBeNull();
 const auth=await authorize(initial,message=>wallet.signMessage({message}),guard);
 expect((await recoverMessageAddress({message:syncGrantMessage(auth.grant),signature:auth.grant.signature as `0x${string}`})).toLowerCase()).toBe(address);
 const latest=await write(initial,auth,env,guard);expect(latest).toMatchObject({revision:1,minimum:2});expect(await decrypt(latest,key)).toEqual(upgradeSyncPayloadV1(legacy()));
 const request=JSON.parse(fetcher.mock.calls[1][1].body);expect(request.expectedRevision).toBe(0);expect(request.blob).toBe(JSON.stringify(env));
 expect((await recoverMessageAddress({message:syncWriteMessage(auth.grant,0,keccak256(stringToHex(request.blob))),signature:request.signature})).toLowerCase()).toBe(auth.grant.device);
 for(const [,options] of fetcher.mock.calls)expect(options).toMatchObject({credentials:'omit',redirect:'error'});
});
it.each([{payloadVersions:undefined},{payloadVersions:[1]},{payloadVersions:['2']},{minPayloadVersion:3},{revision:-1},{epoch:NaN},{service:'https://wrong.test/api/usersync'},{authVersion:1},{blob:''},{blob:'null'},{blob:'[]'},{blob:'{}',minPayloadVersion:2},{minPayloadVersion:2},{revision:3}])('pauses instead of interpreting missing/invalid capability or storage as empty: %j',async patch=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(body(patch))));await expect(read(address,1,guard)).rejects.toThrow();
});
it('refuses a legacy rollback for an upgraded wallet and never treats a copied snapshot as a read proof',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response(body()));vi.stubGlobal('fetch',fetcher);
 await expect(read(address,2,guard)).rejects.toThrow();const initial=await read(address,1,guard),sign=vi.fn();
 await expect(authorize({...initial},sign,guard)).rejects.toThrow();expect(sign).not.toHaveBeenCalled();
});
it('requires successful decryption of existing ciphertext before any replacement can be signed',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response(body({blob:JSON.stringify(env),revision:1,minPayloadVersion:2})));vi.stubGlobal('fetch',fetcher);
 const snapshot=await read(address,2,guard),auth=await authorize(snapshot,message=>wallet.signMessage({message}),guard);const sign=vi.spyOn(auth,'sign');
 await expect(write(snapshot,auth,env,guard)).rejects.toMatchObject({reason:'unreadable'});expect(sign).not.toHaveBeenCalled();
 const wrong=await webcrypto.subtle.importKey('raw',new Uint8Array(32).fill(4),'AES-GCM',false,['decrypt']);await expect(decrypt(snapshot,wrong)).rejects.toThrow();
 await expect(write(snapshot,auth,env,guard)).rejects.toThrow();expect(sign).not.toHaveBeenCalled();
});
it('converts legacy ciphertext only after genuine decryption, retaining arbitrary message fields',async()=>{
 const iv=new Uint8Array(12).fill(7),raw=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(legacy())));
 const blob={version:1,algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address,updatedAt:10,iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(raw).toString('base64')};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(body({blob:JSON.stringify(blob),revision:2}))));
 expect(await decrypt(await read(address,1,guard),key)).toEqual(upgradeSyncPayloadV1(legacy()));
 await expect(read(address,2,guard)).rejects.toThrow();
});
it.each([{ok:true,revision:1},{ok:true,revision:1,minPayloadVersion:1},{ok:true,revision:2,minPayloadVersion:2},{ok:false,revision:1,minPayloadVersion:2}])('does not confirm an old or mismatched acknowledgement: %j',async ack=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(body())).mockResolvedValueOnce(response(ack));vi.stubGlobal('fetch',fetcher);
 const initial=await read(address,1,guard),auth=await authorize(initial,message=>wallet.signMessage({message}),guard);
 await expect(write(initial,auth,env,guard)).rejects.toMatchObject({reason:'unconfirmed'});expect(fetcher).toHaveBeenCalledTimes(2);
});
it('returns a competing newer record for the caller to decrypt and merge, rather than assuming its own write won permanently',async()=>{
 const newer=editSyncPayloadV2(upgradeSyncPayloadV1(legacy()),{kind:'savedMessage',id:'keep',value:null},20),remote=await encryptSyncPayloadV2(newer,key,address);
 const fetcher=vi.fn().mockResolvedValueOnce(response(body())).mockResolvedValueOnce(response({ok:true,revision:1,minPayloadVersion:2})).mockResolvedValueOnce(response(body({blob:JSON.stringify(remote),revision:2,minPayloadVersion:2})));vi.stubGlobal('fetch',fetcher);
 const initial=await read(address,1,guard),auth=await authorize(initial,message=>wallet.signMessage({message}),guard),latest=await write(initial,auth,env,guard);
 expect(latest.revision).toBe(2);expect((await decrypt(latest,key))!.savedMessages.keep.value).toBeNull();
});
it.each([body(),body({blob:JSON.stringify({payloadVersion:2}),revision:1,minPayloadVersion:2,epoch:1})])('requires the post-write read to remain upgraded and in the same authorization epoch',async followup=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(body())).mockResolvedValueOnce(response({ok:true,revision:1,minPayloadVersion:2})).mockResolvedValueOnce(response(followup));vi.stubGlobal('fetch',fetcher);
 const initial=await read(address,1,guard),auth=await authorize(initial,message=>wallet.signMessage({message}),guard);
 await expect(write(initial,auth,env,guard)).rejects.toThrow();
});
it('stops between signing and sending when the wallet/session changes',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response(body()));vi.stubGlobal('fetch',fetcher);let active=true;
 const current=()=>{if(!active)throw Error('Wallet changed');},initial=await read(address,1,current),auth=await authorize(initial,message=>wallet.signMessage({message}),current);
 const original=auth.sign;auth.sign=async message=>{const signature=await original(message);active=false;return signature;};
 await expect(write(initial,auth,env,current)).rejects.toThrow('Wallet changed');expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects expired authority and foreign/invalid envelopes before signing or posting',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response(body()));vi.stubGlobal('fetch',fetcher);const initial=await read(address,1,guard),auth=await authorize(initial,message=>wallet.signMessage({message}),guard),sign=vi.spyOn(auth,'sign');
 for(const patch of [{address:'0x'+'a'.repeat(40)},{iv:'AAAA'},{ciphertext:'AAAA'},{payloadVersion:1}])await expect(write(initial,auth,{...env,...patch} as any,guard)).rejects.toThrow();
 auth.grant.expiresAt=Date.now()-1;await expect(write(initial,auth,env,guard)).rejects.toMatchObject({reason:'authorization'});expect(sign).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(1);
});
it('distinguishes a stale compare-and-swap from a dropped/uncertain response',async()=>{
 for(const status of [409,503]){
  const fetcher=vi.fn().mockResolvedValueOnce(response(body())).mockResolvedValueOnce(response({},status));vi.stubGlobal('fetch',fetcher);const initial=await read(address,1,guard),auth=await authorize(initial,message=>wallet.signMessage({message}),guard);
  await expect(write(initial,auth,env,guard)).rejects.toMatchObject({reason:status===409?'stale':'unconfirmed'});
 }
});
it('does not return a grant when the wallet changes while its signature prompt is open',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response(body()));vi.stubGlobal('fetch',fetcher);let active=true;const current=()=>{if(!active)throw Error('Wallet changed');};
 const snapshot=await read(address,1,current);
 await expect(authorize(snapshot,async message=>{const signature=await wallet.signMessage({message});active=false;return signature;},current)).rejects.toThrow('Wallet changed');
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects a response that arrives after the active wallet/session changed',async()=>{
 let active=true;const current=()=>{if(!active)throw Error('Wallet changed');};
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>{active=false;return response(body());}));
 await expect(read(address,1,current)).rejects.toThrow('Wallet changed');
});
it('does not confirm a write if the response is lost or the subsequent read is unavailable',async()=>{
 for(const lostRead of [false,true]){
  const fetcher=vi.fn().mockResolvedValueOnce(response(body()));
  if(lostRead)fetcher.mockResolvedValueOnce(response({ok:true,revision:1,minPayloadVersion:2}));
  fetcher.mockRejectedValueOnce(Error('Synthetic network loss'));vi.stubGlobal('fetch',fetcher);
  const snapshot=await read(address,1,guard),auth=await authorize(snapshot,message=>wallet.signMessage({message}),guard);
  await expect(write(snapshot,auth,env,guard)).rejects.toMatchObject({reason:'unconfirmed'});
  expect(fetcher).toHaveBeenCalledTimes(lostRead?3:2);
 }
});
it('does not confirm a stale post-write read even if it advertises format2',async()=>{
 const existing=body({blob:JSON.stringify(env),revision:1,minPayloadVersion:2});
 const fetcher=vi.fn().mockResolvedValueOnce(response(existing)).mockResolvedValueOnce(response({ok:true,revision:2,minPayloadVersion:2})).mockResolvedValueOnce(response(existing));vi.stubGlobal('fetch',fetcher);
 const snapshot=await read(address,2,guard);await decrypt(snapshot,key);const auth=await authorize(snapshot,message=>wallet.signMessage({message}),guard);
 await expect(write(snapshot,auth,env,guard)).rejects.toMatchObject({reason:'unconfirmed'});
});
it('rejects a grant scoped to another epoch or wallet before signing the write',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(body())));const snapshot=await read(address,1,guard),auth=await authorize(snapshot,message=>wallet.signMessage({message}),guard),sign=vi.spyOn(auth,'sign');
 for(const patch of [{epoch:1},{address:'0x'+'a'.repeat(40)},{service:'https://wrong.test/api/usersync'}])await expect(write(snapshot,{...auth,grant:{...auth.grant,...patch}},env,guard)).rejects.toMatchObject({reason:'authorization'});
 expect(sign).not.toHaveBeenCalled();
});
