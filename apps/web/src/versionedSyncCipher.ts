import { parseSyncPayloadV2, type SyncPayloadV2 } from './versionedSync';
export interface SyncEnvelopeV2 {
  version: 1;
  payloadVersion: 2;
  algorithm: 'AES-GCM';
  kdf: 'HKDF-SHA-256';
  address: string;
  iv: string;
  ciphertext: string;
  updatedAt: number;
}
const encoder = new TextEncoder();
const fail = () => { throw Error('Encrypted sync could not be safely read or prepared. Existing data must be preserved.'); };
const wallet = (value: string) => {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value)) return fail();
  return value.toLowerCase();
};
const aad = (address: string, updatedAt: number) => encoder.encode(`Chat encrypted settings payload v2\nWallet: ${address}\nUpdated at: ${updatedAt}`);
function encode(bytes: Uint8Array) {
  let result = ''; for (const byte of bytes) result += String.fromCharCode(byte); return btoa(result);
}
function decode(value: unknown) {
  if (typeof value !== 'string' || value.length > 400000) return fail();
  try { const raw = atob(value); if (btoa(raw) !== value) return fail(); return Uint8Array.from(raw, char => char.charCodeAt(0)); } catch { return fail(); }
}
export function parseSyncEnvelopeV2(value: unknown, expectedWallet: string): SyncEnvelopeV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const blob = value as SyncEnvelopeV2;
  if (Object.keys(blob).sort().join(',') !== 'address,algorithm,ciphertext,iv,kdf,payloadVersion,updatedAt,version'
    || blob.version !== 1 || blob.payloadVersion !== 2 || blob.algorithm !== 'AES-GCM' || blob.kdf !== 'HKDF-SHA-256'
    || wallet(blob.address) !== wallet(expectedWallet) || !Number.isSafeInteger(blob.updatedAt) || blob.updatedAt < 0 || blob.updatedAt >= Number.MAX_SAFE_INTEGER
    || encoder.encode(JSON.stringify(blob)).length > 400000) return fail();
  if (decode(blob.iv).length !== 12 || decode(blob.ciphertext).length < 16) return fail();
  return Object.freeze({ ...blob });
}
/** Reuses the existing wallet-derived key, but authenticates format, owner and
 * timestamp as v2 additional data. No key material or signature is persisted. */
export async function encryptSyncPayloadV2(value: unknown, key: CryptoKey, address: string): Promise<SyncEnvelopeV2> {
  const payload = parseSyncPayloadV2(value), owner = wallet(address), iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(owner, payload.updatedAt) }, key, encoder.encode(JSON.stringify(payload)));
  return parseSyncEnvelopeV2({version:1,payloadVersion:2,algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address:owner,iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext)),updatedAt:payload.updatedAt}, owner);
}
export async function decryptSyncPayloadV2(value: unknown, key: CryptoKey, address: string): Promise<SyncPayloadV2> {
  try {
    const blob = parseSyncEnvelopeV2(value, address), iv = decode(blob.iv), ciphertext = decode(blob.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 16) return fail();
    const decrypted = await crypto.subtle.decrypt({ name:'AES-GCM',iv,additionalData:aad(wallet(address),blob.updatedAt) },key,ciphertext);
    const payload = parseSyncPayloadV2(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decrypted)));
    if (payload.updatedAt !== blob.updatedAt) return fail(); return payload;
  } catch { return fail(); }
}
