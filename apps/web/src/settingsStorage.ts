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

function parsePrefs(value: unknown): { prefs: SettingsPrefs; updatedAt: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsStorageError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['readReceiptsDefault', 'readReceiptOverrides', 'syncAcrossDevices', 'blocked', 'updatedAt'].includes(key))) throw new SettingsStorageError();
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
  return { prefs: { readReceiptsDefault: record.readReceiptsDefault === true, syncAcrossDevices: record.syncAcrossDevices === true,
    blocked: [...new Set(blocked.map(address => address.toLowerCase()))], readReceiptOverrides: normalizeReceiptOverrides(overrides) }, updatedAt };
}

/** Retains the old key and preference fields. Missing optional fields remain compatible. */
export function loadSettings(key: string) {
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
    const data = parsePrefs({ ...prefs, updatedAt });
    const raw = JSON.stringify({ ...data.prefs, updatedAt: data.updatedAt });
    if (raw.length > 512 * 1024 || localStorage.getItem(key) !== expectedRaw) throw new SettingsStorageError();
    localStorage.setItem(key, raw);
    return raw;
  } catch { throw new SettingsStorageError(); }
}
