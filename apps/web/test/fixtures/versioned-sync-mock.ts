import { decryptSettingsPayload } from '../../src/syncPayload';
import { decryptSyncPayloadV2 } from '../../src/versionedSyncCipher';
import { upgradeSyncPayloadV1 } from '../../src/versionedSync';
/** Provider tests delay service boundaries but still decrypt real ciphertext. */
export function versionedSyncMock(original: any, mocks: any) {
  const snapshot = (blob: any) => ({ address: mocks.address, epoch: 0, blob, minimum: blob?.payloadVersion === 2 ? 2 : 1 });
  return { ...original,
    readVersionedSync: async (_address: string, minimum: number, guard: () => void) => {
      guard(); const result = snapshot(await mocks.pull()); guard();
      if (result.minimum < minimum) throw new original.VersionedSyncError('unreadable');
      return result;
    },
    decryptVersionedSync: async (snapshot: any, key: CryptoKey) => snapshot.blob === null ? null : snapshot.minimum === 2
      ? decryptSyncPayloadV2(snapshot.blob, key, snapshot.address) : upgradeSyncPayloadV1(await decryptSettingsPayload(snapshot.blob, key, snapshot.address)),
    authorizeVersionedSync: async (...args: any[]) => { const result = await mocks.authorize(...args); return { ...result, grant: { ...result.grant, epoch: 0 } }; },
    writeVersionedSync: async (_snapshot: any, _authorization: any, envelope: any, guard: () => void) => {
      guard(); const result = await mocks.push(envelope); guard();
      if (!result.ok) throw new original.VersionedSyncError(result.stale ? 'stale' : 'unconfirmed');
      return snapshot(envelope);
    },
  };
}
