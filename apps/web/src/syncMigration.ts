import { applySyncPreferences, samePreferences, type SettingsPrefs } from './settingsStorage';
import { mergeSyncPayloadV2, upgradeSyncPayloadV1, type SyncPayloadV2 } from './versionedSync';
export type SyncMigrationChoice = 'remote' | 'local';
export class SyncMigrationChoiceError extends Error {
  constructor() { super('This wallet already uses upgraded sync. Choose which receipt and legacy blocked-address settings to keep. Your older encrypted local copy is retained.'); }
}
/** Once the remote format is upgraded, a legacy snapshot cannot give stale
 * saved items or unrelated preferences fresh timestamps. Only explicit current
 * preference choices can be applied; old encrypted local bytes remain intact. */
export function prepareSyncMigration(local: { prefs: SettingsPrefs; updatedAt: number; syncPayload?: SyncPayloadV2 }, remote: SyncPayloadV2 | null, minimum: 1 | 2, choice?: SyncMigrationChoice, legacyCache?: SyncPayloadV2) {
  if (choice !== undefined && choice !== 'remote' && choice !== 'local') throw new Error('Invalid sync migration choice.');
  if (local.syncPayload) return remote ? mergeSyncPayloadV2(local.syncPayload, remote) : local.syncPayload;
  if (minimum === 2) {
    if (!remote) throw new Error('Upgraded sync data is missing.');
    const remotePrefs = { readReceiptsDefault: remote.readReceiptsDefault.value, syncAcrossDevices: false,
      blocked: Object.entries(remote.blocked).filter(([, value]) => value.value).map(([address]) => address),
      readReceiptOverrides: Object.fromEntries(Object.entries(remote.readReceiptOverrides).filter(([, item]) => item.value !== null).map(([key, item]) => [key, item.value as boolean])) };
    if (!samePreferences({ ...local.prefs, syncAcrossDevices: false }, remotePrefs) && !choice) throw new SyncMigrationChoiceError();
    return choice === 'local' ? applySyncPreferences(remote, { ...local.prefs, syncAcrossDevices: false }, Date.now()) : remote;
  }
  let result = upgradeSyncPayloadV1({ version: 1, settingsPrefs: local.prefs, savedMessages: [], updatedAt: local.updatedAt });
  if (legacyCache) result = mergeSyncPayloadV2(result, legacyCache);
  return remote ? mergeSyncPayloadV2(result, remote) : result;
}
