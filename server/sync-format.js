const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const address = value => typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
const base64 = value => typeof value === 'string' && value.length <= 400000 && Buffer.from(value, 'base64').toString('base64') === value;
export const SYNC_PAYLOAD_VERSIONS = [1, 2];
/** The version is inside the signed blob, never an unsigned request hint. The
 * server validates the envelope only; it cannot certify encrypted plaintext. */
export function syncPayloadVersion(blob, wallet) {
  if (typeof blob !== 'string' || Buffer.byteLength(blob, 'utf8') > 400000) throw Error('Invalid sync blob');
  let value; try { value = JSON.parse(blob); } catch { return 1; } // Existing opaque legacy records stay compatible.
  if (!record(value) || !Object.hasOwn(value, 'payloadVersion')) return 1;
  if (Object.keys(value).sort().join(',') !== 'address,algorithm,ciphertext,iv,kdf,payloadVersion,updatedAt,version'
    || value.payloadVersion !== 2 || value.version !== 1 || value.algorithm !== 'AES-GCM' || value.kdf !== 'HKDF-SHA-256'
    || !address(value.address) || value.address.toLowerCase() !== wallet.toLowerCase() || !integer(value.updatedAt)
    || !base64(value.iv) || Buffer.from(value.iv, 'base64').length !== 12
    || !base64(value.ciphertext) || Buffer.from(value.ciphertext, 'base64').length < 16) throw Error('Invalid sync payload format');
  return 2;
}
/** Unknown/corrupt data is preserved; it must never silently become an empty
 * record or reset the permanent minimum format/replay revision. */
export function parseSyncRecord(raw, wallet) {
  if (raw === null) return { blob: null, updatedAt: 0, revision: 0, minPayloadVersion: 1 };
  if (typeof raw !== 'string' || raw.length > 2401024) throw Error('Invalid sync storage');
  const value = JSON.parse(raw);
  if (!record(value) || Object.keys(value).some(key => !['blob', 'updatedAt', 'revision', 'minPayloadVersion'].includes(key))
    || typeof value.blob !== 'string' || !integer(value.updatedAt)
    || Object.hasOwn(value, 'revision') && !integer(value.revision)) throw Error('Invalid sync storage');
  const version = syncPayloadVersion(value.blob, wallet);
  if (Object.hasOwn(value, 'minPayloadVersion') && value.minPayloadVersion !== version) throw Error('Invalid sync format floor');
  return { blob: value.blob, updatedAt: value.updatedAt, revision: value.revision ?? 0, minPayloadVersion: version };
}

/** Version2 has its own permanent slot: immutable older API deployments know
 * only the legacy key and cannot overwrite or reset the upgraded record. */
export function parseSyncStorage(legacyRaw, upgradedRaw, wallet) {
  if (upgradedRaw !== null) {
    const upgraded = parseSyncRecord(upgradedRaw, wallet);
    if (upgraded.minPayloadVersion !== 2 || upgraded.revision === 0 || upgraded.updatedAt === 0) throw Error('Invalid upgraded sync storage');
    return upgraded;
  }
  const legacy = parseSyncRecord(legacyRaw, wallet);
  if (legacy.minPayloadVersion !== 1) throw Error('Unexpected legacy sync format');
  return legacy;
}
