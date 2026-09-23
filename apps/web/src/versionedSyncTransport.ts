import { keccak256, stringToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { SYNC_AUTH_MAX_AGE, syncGrantMessage, syncWriteMessage, type SyncDeviceGrant } from '@app/core';
import { syncEndpoint } from './apiEndpoint';
import { decryptSettingsPayload } from './syncPayload';
import { decryptSyncPayloadV2, parseSyncEnvelopeV2, type SyncEnvelopeV2 } from './versionedSyncCipher';
import { upgradeSyncPayloadV1 } from './versionedSync';
import type { EncryptedSyncBlobSnapshot, SyncAuthorization } from './userSync';

export interface VersionedSyncSnapshot {
  readonly address: string;
  readonly service: string;
  readonly epoch: number;
  readonly revision: number;
  readonly minimum: 1 | 2;
}
type Guard = () => void;
const seen = new WeakMap<VersionedSyncSnapshot, EncryptedSyncBlobSnapshot | SyncEnvelopeV2 | null>();
const decrypted = new WeakSet<VersionedSyncSnapshot>();
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
const addressKey = (address: string) => {
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('Invalid sync wallet.');
  return address.toLowerCase();
};
export class VersionedSyncError extends Error {
  constructor(readonly reason: 'unreadable' | 'stale' | 'unconfirmed' | 'authorization') {
    super(reason === 'unconfirmed' ? 'Sync was not confirmed. Keep local data and reread before retrying.' : 'Sync is paused. Existing data was preserved; refresh access before retrying.');
  }
}
function requireSnapshot(snapshot: VersionedSyncSnapshot) {
  if (!seen.has(snapshot) || snapshot.service !== syncEndpoint().service) throw new VersionedSyncError('unreadable');
  return seen.get(snapshot)!;
}
/** Capability checks precede decryption/application. Pass minimum2 whenever
 * local state has upgraded; an older or empty remote view must not downgrade it. */
export async function readVersionedSync(address: string, minimum: 1 | 2, ensureCurrent: Guard): Promise<VersionedSyncSnapshot> {
  ensureCurrent();
  const owner = addressKey(address), endpoint = syncEndpoint();
  if (minimum !== 1 && minimum !== 2) throw new VersionedSyncError('unreadable');
  const response = await fetch(`${endpoint.requestUrl}?address=${encodeURIComponent(owner)}`, {
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
  });
  ensureCurrent();
  if (!response.ok) throw new VersionedSyncError('unreadable');
  const value = await response.json();
  ensureCurrent();
  if (endpoint.service !== syncEndpoint().service || value?.service !== endpoint.service || value?.authVersion !== 2
    || !integer(value.revision) || !integer(value.epoch) || !Array.isArray(value.payloadVersions)
    || !value.payloadVersions.includes(2) || value.payloadVersions.some((v: unknown) => !integer(v) || v < 1)
    || ![1, 2].includes(value.minPayloadVersion) || value.minPayloadVersion < minimum
    || (value.blob !== null && (typeof value.blob !== 'string' || !value.blob || new TextEncoder().encode(value.blob).length > 400000))) throw new VersionedSyncError('unreadable');
  let blob: EncryptedSyncBlobSnapshot | SyncEnvelopeV2 | null;
  try {
    blob = value.blob === null ? null : JSON.parse(value.blob);
    if (blob === null ? value.blob !== null || value.minPayloadVersion !== 1 || value.revision !== 0
      : !blob || typeof blob !== 'object' || Array.isArray(blob) || (Object.hasOwn(blob, 'payloadVersion') ? (blob as SyncEnvelopeV2).payloadVersion !== 2 || value.minPayloadVersion !== 2 : value.minPayloadVersion !== 1)) throw new Error();
  } catch { throw new VersionedSyncError('unreadable'); }
  if (value.minPayloadVersion === 2) {
    if (value.revision === 0) throw new VersionedSyncError('unreadable');
    try { blob = parseSyncEnvelopeV2(blob, owner); } catch { throw new VersionedSyncError('unreadable'); }
  }
  const snapshot = Object.freeze({ address: owner, service: endpoint.service, epoch: value.epoch, revision: value.revision, minimum: value.minPayloadVersion as 1 | 2 });
  seen.set(snapshot, blob);
  return snapshot;
}
/** The returned plaintext must still be persisted atomically with local state.
 * Legacy conversion is only permitted before this wallet has upgraded. */
export async function decryptVersionedSync(snapshot: VersionedSyncSnapshot, key: CryptoKey) {
  const blob = requireSnapshot(snapshot);
  if (blob === null) return null;
  const payload = snapshot.minimum === 2 ? await decryptSyncPayloadV2(blob, key, snapshot.address)
    : upgradeSyncPayloadV1(await decryptSettingsPayload(blob, key, snapshot.address));
  decrypted.add(snapshot); return payload;
}
export async function authorizeVersionedSync(snapshot: VersionedSyncSnapshot, walletSign: (message: string) => Promise<string>, ensureCurrent: Guard): Promise<SyncAuthorization> {
  ensureCurrent(); requireSnapshot(snapshot);
  const device = privateKeyToAccount(generatePrivateKey()), issuedAt = Date.now();
  const grant: SyncDeviceGrant = { version: 2, service: snapshot.service, address: snapshot.address, epoch: snapshot.epoch,
    device: device.address.toLowerCase(), issuedAt, expiresAt: issuedAt + SYNC_AUTH_MAX_AGE };
  const signature = await walletSign(syncGrantMessage(grant));
  ensureCurrent(); requireSnapshot(snapshot);
  return { grant: { ...grant, signature }, sign: message => device.signMessage({ message }) };
}
/** Exact read revision only: no default/global write base. A successful result
 * includes a fresh authoritative snapshot, which may include another device's
 * later edit and must be decrypted/merged rather than replaced with our input. */
export async function writeVersionedSync(snapshot: VersionedSyncSnapshot, authorization: SyncAuthorization, envelope: SyncEnvelopeV2, ensureCurrent: Guard): Promise<VersionedSyncSnapshot> {
  ensureCurrent();
  if (requireSnapshot(snapshot) !== null && !decrypted.has(snapshot)) throw new VersionedSyncError('unreadable');
  const { grant } = authorization;
  const check = () => {
    ensureCurrent(); requireSnapshot(snapshot);
    if (grant.address !== snapshot.address || grant.service !== snapshot.service || grant.epoch !== snapshot.epoch
      || grant.expiresAt <= Date.now() || snapshot.revision >= Number.MAX_SAFE_INTEGER - 1) throw new VersionedSyncError('authorization');
  };
  check();
  // Encryptor validates schema/encoding. Never sign a legacy or foreign envelope.
  const blob = JSON.stringify(parseSyncEnvelopeV2(envelope, snapshot.address));
  if (new TextEncoder().encode(blob).length > 400000) throw new VersionedSyncError('unreadable');
  const signature = await authorization.sign(syncWriteMessage(grant, snapshot.revision, keccak256(stringToHex(blob))));
  check();
  let response: Response;
  try {
    response = await fetch(syncEndpoint().requestUrl, { credentials: 'omit', redirect: 'error', method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'write', address: snapshot.address, authorization: grant, signature, blob, expectedRevision: snapshot.revision }), signal: AbortSignal.timeout(10000) });
    ensureCurrent();
    if (response.status === 409) throw new VersionedSyncError('stale');
    if (!response.ok) throw new VersionedSyncError('unconfirmed');
    const result = await response.json();
    ensureCurrent();
    if (result?.ok !== true || result.minPayloadVersion !== 2 || result.revision !== snapshot.revision + 1) throw new VersionedSyncError('unconfirmed');
    const latest = await readVersionedSync(snapshot.address, 2, ensureCurrent);
    if (latest.epoch !== snapshot.epoch || latest.revision < result.revision) throw new VersionedSyncError('unconfirmed');
    return latest;
  } catch (error) {
    if (error instanceof VersionedSyncError) throw error;
    throw new VersionedSyncError('unconfirmed');
  }
}
