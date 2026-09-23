import { editSyncPayloadV2, mergeSyncPayloadV2, parseSyncPayloadV2, syncPayloadV2View, type SyncPayloadV2 } from './versionedSync';
import { normalizeReceiptOverrides, type ReceiptOverrides } from './receiptPreferences';

export interface SettingsPrefs {
  readReceiptsDefault: boolean;
  readReceiptOverrides?: ReceiptOverrides;
  syncAcrossDevices: boolean;
  blocked: string[];
}
export const SETTINGS_STORAGE_ERROR = 'Settings could not be saved or safely read. Existing browser data was kept. Restore storage access and reload before retrying.';
export class SettingsStorageError extends Error {
  constructor() { super(SETTINGS_STORAGE_ERROR); }
}
export const defaultSettings = (): SettingsPrefs => ({ readReceiptsDefault: false, readReceiptOverrides: {}, syncAcrossDevices: false, blocked: [] });

function parsePrefs(value: unknown): { prefs: SettingsPrefs; updatedAt: number; syncPayload?: SyncPayloadV2; syncMinimum?: 1 | 2 } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsStorageError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['readReceiptsDefault', 'readReceiptOverrides', 'syncAcrossDevices', 'blocked', 'updatedAt', 'syncPayload', 'syncMinimum'].includes(key))) throw new SettingsStorageError();
  for (const key of ['readReceiptsDefault', 'syncAcrossDevices']) {
    if (key in record && typeof record[key] !== 'boolean') throw new SettingsStorageError();
  }
  const blocked = record.blocked === undefined ? [] : record.blocked;
  if (!Array.isArray(blocked) || blocked.length > 1000 || blocked.some(address => typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address))) throw new SettingsStorageError();
  const overrides = record.readReceiptOverrides === undefined ? {} : record.readReceiptOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 1000
    || Object.keys(normalizeReceiptOverrides(overrides)).length !== Object.keys(overrides).length) throw new SettingsStorageError();
  const updatedAt = record.updatedAt === undefined ? 0 : record.updatedAt;
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0 || updatedAt >= Number.MAX_SAFE_INTEGER) throw new SettingsStorageError();
  const prefs = { readReceiptsDefault: record.readReceiptsDefault === true, syncAcrossDevices: record.syncAcrossDevices === true,
    blocked: [...new Set(blocked.map(address => address.toLowerCase()))], readReceiptOverrides: normalizeReceiptOverrides(overrides) };
  if (!Object.hasOwn(record, 'syncPayload')) {
    if (Object.hasOwn(record, 'syncMinimum')) throw new SettingsStorageError();
    return { prefs, updatedAt };
  }
  if (record.syncMinimum !== 1 && record.syncMinimum !== 2) throw new SettingsStorageError();
  const syncPayload = parseSyncPayloadV2(record.syncPayload);
  if (updatedAt < syncPayload.updatedAt || !samePreferences(prefs, syncPayloadV2View(syncPayload).settingsPrefs)) throw new SettingsStorageError();
  return { prefs, updatedAt, syncPayload, syncMinimum: record.syncMinimum };
}

/** Retains the old key and preference fields. Missing optional fields remain compatible. */
export function loadSettings(key: string): { raw: string | null; prefs: SettingsPrefs; updatedAt: number; syncPayload?: SyncPayloadV2; syncMinimum?: 1 | 2; failed: boolean } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
    if (raw === null) return { raw, prefs: defaultSettings(), updatedAt: 0, failed: false };
    if (raw.length > 512 * 1024) throw new SettingsStorageError();
    return { raw, ...parsePrefs(JSON.parse(raw)), failed: false };
  } catch { return { raw, prefs: defaultSettings(), updatedAt: 0, failed: true }; }
}

/** One atomic setItem includes its timestamp. No separate timestamp write can partially commit. */
export function saveSettings(key: string, expectedRaw: string | null, prefs: SettingsPrefs, updatedAt: number): string {
  try {
    const previous = parseSettingsRaw(expectedRaw);
    const metadata = previous.syncPayload ? applySyncPreferences(previous.syncPayload, prefs, updatedAt) : undefined;
    const raw = serializeSettings(prefs, Math.max(updatedAt, metadata?.updatedAt ?? 0), metadata, previous.syncMinimum);
    if (raw.length > 512 * 1024 || localStorage.getItem(key) !== expectedRaw) throw new SettingsStorageError();
    localStorage.setItem(key, raw);
    return raw;
  } catch { throw new SettingsStorageError(); }
}

export const walletSettingsKey = (wallet: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new SettingsStorageError();
  return `chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`;
};
export const recoveryMarkerKey = (key: string) => `${key}:recovery-pending`;
export function assertNoRecoveryPending(key: string) {
  try { if (localStorage.getItem(recoveryMarkerKey(key)) !== null) throw new SettingsStorageError(); }
  catch { throw new SettingsStorageError(); }
}
export async function withSettingsLock<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
  if (!navigator.locks) throw new SettingsStorageError();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try { return await navigator.locks.request(`${key}:write`, { signal: abort.signal }, operation); }
  finally { clearTimeout(timer); }
}
export function parseSettingsRaw(raw: string | null) {
  if (raw === null) return { prefs: defaultSettings(), updatedAt: 0 };
  if (typeof raw !== 'string' || raw.length > 512 * 1024) throw new SettingsStorageError();
  return parsePrefs(JSON.parse(raw));
}
export function serializeSettings(prefs: SettingsPrefs, updatedAt: number, syncPayload?: SyncPayloadV2, syncMinimum: 1 | 2 = 2) {
  const data = parsePrefs({ ...prefs, updatedAt, ...(syncPayload ? { syncPayload, syncMinimum } : {}) });
  const raw = JSON.stringify({ ...data.prefs, updatedAt: data.updatedAt, ...(data.syncPayload ? { syncPayload: data.syncPayload, syncMinimum: data.syncMinimum } : {}) });
  if (raw.length > 512 * 1024) throw new SettingsStorageError();
  return raw;
}

/** Compare visible choices independently of map/array insertion order. */
export function samePreferences(a: SettingsPrefs, b: SettingsPrefs) {
  const normalized = (p: SettingsPrefs) => JSON.stringify({ readReceiptsDefault: p.readReceiptsDefault, syncAcrossDevices: p.syncAcrossDevices,
    blocked: [...p.blocked].sort(), readReceiptOverrides: Object.fromEntries(Object.entries(p.readReceiptOverrides ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
  return normalized(a) === normalized(b);
}
/** Apply explicit preference edits only. Remote merges must use their full
 * metadata, never regenerate it from the visible view. */
export function applySyncPreferences(input: SyncPayloadV2, target: SettingsPrefs, now: number) {
  let result = parseSyncPayloadV2(input);
  const next = parsePrefs({ ...target, updatedAt: now }).prefs;
  const previous = syncPayloadV2View(result).settingsPrefs;
  for (const kind of ['readReceiptsDefault', 'syncAcrossDevices'] as const) if (previous[kind] !== next[kind]) result = editSyncPayloadV2(result, { kind, value: next[kind] }, now);
  for (const key of new Set([...Object.keys(previous.readReceiptOverrides), ...Object.keys(next.readReceiptOverrides ?? {})])) {
    const before = previous.readReceiptOverrides[key], after = next.readReceiptOverrides?.[key];
    if (before !== after) result = editSyncPayloadV2(result, { kind: 'readReceiptOverride', key, value: after ?? null }, now);
  }
  const before = new Set(previous.blocked), after = new Set(next.blocked);
  for (const address of new Set([...before, ...after])) if (before.has(address) !== after.has(address)) result = editSyncPayloadV2(result, { kind: 'block', address, value: after.has(address) }, now);
  return result;
}
/** Caller holds the existing wallet lock and has checked current authority.
 * This writes full synchronized metadata and its view in one atomic operation. */
export function saveSyncedSettings(key: string, expectedRaw: string | null, input: SyncPayloadV2, minimum: 1 | 2 = 2) {
  try {
    if (minimum !== 1 && minimum !== 2) throw new SettingsStorageError();
    const previous = parseSettingsRaw(expectedRaw);
    const payload = previous.syncPayload ? mergeSyncPayloadV2(previous.syncPayload, input) : parseSyncPayloadV2(input);
    const raw = serializeSettings(syncPayloadV2View(payload).settingsPrefs, Math.max(previous.updatedAt, payload.updatedAt), payload, Math.max(previous.syncMinimum ?? 1, minimum) as 1 | 2);
    if (localStorage.getItem(key) !== expectedRaw) throw new SettingsStorageError();
    localStorage.setItem(key, raw); return raw;
  } catch { throw new SettingsStorageError(); }
}
