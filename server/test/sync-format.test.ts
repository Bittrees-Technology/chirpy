import { expect, it } from 'vitest';
import { parseSyncRecord, parseSyncStorage, syncPayloadVersion } from '../sync-format.js';
const address = '0x'+'1'.repeat(40);
const envelope = () => ({version:1, algorithm:'AES-GCM', kdf:'HKDF-SHA-256', address, iv:Buffer.alloc(12).toString('base64'), ciphertext:Buffer.alloc(16).toString('base64'), updatedAt:1, payloadVersion:2});
it('retains opaque legacy records and exposes an empty-store floor without writing', () => {
  for (const blob of ['encrypted legacy', '', '{}', 'null', '[]']) expect(syncPayloadVersion(blob,address)).toBe(1);
  expect(parseSyncRecord(null,address)).toEqual({blob:null,revision:0,updatedAt:0,minPayloadVersion:1});
  expect(parseSyncRecord(JSON.stringify({blob:'encrypted legacy',updatedAt:123}),address)).toEqual({blob:'encrypted legacy',updatedAt:123,revision:0,minPayloadVersion:1});
});
it('recognizes only a structurally valid signed v2 envelope bound to the same wallet', () => {
  expect(syncPayloadVersion(JSON.stringify(envelope()),address)).toBe(2);
  const blob=JSON.stringify(envelope()); expect(parseSyncRecord(JSON.stringify({blob,revision:4,updatedAt:123}),address).minPayloadVersion).toBe(2);
  expect(parseSyncRecord(JSON.stringify({blob,revision:4,updatedAt:123,minPayloadVersion:2}),address).revision).toBe(4);
});
it.each([{payloadVersion:1},{payloadVersion:3},{payloadVersion:null},{payloadVersion:'2'},{version:2},{address:'0x'+'2'.repeat(40)}, {iv:'AAAA'}, {ciphertext:'AAAA'}, {iv:'AAAAAAAAAAAAAAAA\n'}, {ciphertext:'AA=='}, {algorithm:'unknown'}, {kdf:'unknown'}, {extra:true}, {updatedAt:-1}, {updatedAt:1.5}])('rejects unsupported or malformed explicit format %#', patch => {
  expect(()=>syncPayloadVersion(JSON.stringify({...envelope(),...patch}),address)).toThrow();
});
it.each(['', 'null', '[]', '{}', '{', JSON.stringify({blob:'legacy',updatedAt:0,revision:'1'}),JSON.stringify({blob:'legacy',updatedAt:0,revision:1,minPayloadVersion:2}),JSON.stringify({blob:'legacy',updatedAt:0,revision:1,minPayloadVersion:0}),JSON.stringify({blob:'legacy',updatedAt:0,revision:1,unknown:true}),JSON.stringify({blob:'legacy',updatedAt:0,revision:Number.MAX_SAFE_INTEGER})])('never turns invalid stored bytes into an empty record %#', raw => {
  expect(()=>parseSyncRecord(raw,address)).toThrow();
});
it('bounds encrypted payload size without truncation',()=>{
  expect(()=>syncPayloadVersion('a'.repeat(400001),address)).toThrow();
  expect(()=>syncPayloadVersion('é'.repeat(200001),address)).toThrow();
  expect(syncPayloadVersion('a'.repeat(400000),address)).toBe(1);
});

it('prefers the permanent upgraded slot, but never falls back from corrupt upgraded data',()=>{
  const upgraded=JSON.stringify({blob:JSON.stringify(envelope()),revision:5,updatedAt:1,minPayloadVersion:2});
  expect(parseSyncStorage('broken legacy bytes',upgraded,address)).toMatchObject({revision:5,minPayloadVersion:2});
  const legacy=JSON.stringify({blob:'legacy',revision:2,updatedAt:1});
  for(const invalid of ['broken','null',legacy,upgraded.replace('"revision":5','"revision":0'),upgraded.replace('"updatedAt":1,"minPayloadVersion"','"updatedAt":0,"minPayloadVersion"')])expect(()=>parseSyncStorage(legacy,invalid,address)).toThrow();
  expect(()=>parseSyncStorage(upgraded,null,address)).toThrow();
});
