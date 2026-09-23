import { afterEach, expect, it, vi } from 'vitest';
import { syncPayloadVersion } from '../../../server/sync-format.js';
import { webcrypto } from 'node:crypto';
import { encryptSyncPayloadV2 as encrypt, decryptSyncPayloadV2 as decrypt } from '../src/versionedSyncCipher';
import { editSyncPayloadV2 as edit, upgradeSyncPayloadV1 as upgrade } from '../src/versionedSync';
const address='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40);
const source=()=>edit(upgrade({version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[other]},savedMessages:[{id:'m1',body:'preserved'}],updatedAt:10}),{kind:'savedMessage',id:'m1',value:null},20);
const key=async(byte=1)=>{vi.stubGlobal('crypto',webcrypto);return webcrypto.subtle.importKey('raw',new Uint8Array(32).fill(byte),{name:'AES-GCM'},false,['encrypt','decrypt']);};
afterEach(()=>vi.unstubAllGlobals());
it('round-trips encrypted values and deletion markers with a fresh nonce and unchanged key authority',async()=>{
  const secret=await key(),payload=source(),first=await encrypt(payload,secret,address),second=await encrypt(payload,secret,address);
  expect(await decrypt(first,secret,address)).toEqual(payload);expect(await decrypt(second,secret,address)).toEqual(payload);expect(first.iv).not.toBe(second.iv);expect(first.payloadVersion).toBe(2);
  expect(syncPayloadVersion(JSON.stringify(first),address)).toBe(2);
  expect(JSON.stringify(first)).not.toContain('savedMessages');expect(JSON.stringify(first)).not.toContain('privateKey');
  await expect(decrypt(first,await key(2),address)).rejects.toThrow();await expect(decrypt(first,secret,other)).rejects.toThrow();
});
it('rejects altered outer metadata, bytes, wrong format and noncanonical encodings',async()=>{
  const secret=await key(),blob=await encrypt(source(),secret,address);
  for(const patch of [{payloadVersion:1},{version:2},{updatedAt:21},{address:other},{algorithm:'other'},{kdf:'other'},{extra:true},{iv:blob.iv+'\n'},{iv:'AAAA'},{ciphertext:blob.ciphertext+' '},{ciphertext:'AAAA'},{updatedAt:Number.MAX_SAFE_INTEGER}])await expect(decrypt({...blob,...patch},secret,address)).rejects.toThrow();
  const bytes=Buffer.from(blob.ciphertext,'base64');bytes[0]^=1;await expect(decrypt({...blob,ciphertext:bytes.toString('base64')},secret,address)).rejects.toThrow();
});
it('will not read legacy encryption as v2 or accept a valid ciphertext containing an unsupported inner schema',async()=>{
  const secret=await key(),iv=new Uint8Array(12).fill(3),payload=source();
  const raw=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},secret,new TextEncoder().encode(JSON.stringify(payload)));
  const blob={version:1,payloadVersion:2,algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address,iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(raw).toString('base64'),updatedAt:20};
  await expect(decrypt(blob,secret,address)).rejects.toThrow();
  for(const invalid of [{...payload,version:3},{...payload,unknown:'preserve me'},{...payload,updatedAt:21}]){
    const ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`Chat encrypted settings payload v2\nWallet: ${address}\nUpdated at: 20`)},secret,new TextEncoder().encode(JSON.stringify(invalid)));
    await expect(decrypt({...blob,ciphertext:Buffer.from(ciphertext).toString('base64')},secret,address)).rejects.toThrow();
  }
});
it('rejects a wire envelope exceeding the actual API byte limit instead of returning an unusable snapshot',async()=>{
  const secret=await key(),empty=edit(source(),{kind:'savedMessage',id:'large',value:{id:'large',body:''}},30);
  const overhead=new TextEncoder().encode(JSON.stringify(empty)).length;
  const payload=edit(source(),{kind:'savedMessage',id:'large',value:{id:'large',body:'a'.repeat(300000-overhead)}},30);
  expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBe(300000);
  // Near the plaintext limit, the envelope and authentication tag push the wire representation over400000bytes.
  await expect(encrypt(payload,secret,address)).rejects.toThrow();
});
