import { parseSyncPayloadV2, syncPayloadV2View, type SyncPayloadV2 } from './versionedSync';
import { samePreferences } from './settingsStorage';
import { recoveryCipher } from './recoveryCipher';
import { validWalletLabel } from './walletProfile';
/** Portable application data only. Never pass storage snapshots or wallet credentials here. */
interface RecoveryFields {
  source: 'chirpy' | 'governance' | 'research';
  wallet: string;
  createdAt: number;
  contacts: { address: string; label: string }[];
  notes: { id: string; text: string; sentAtMs: number }[];
  preferences: {
    blocked: string[];
    readReceiptsDefault: boolean;
    readReceiptOverrides: Record<string, boolean>;
  };
}
export type RecoveryData = RecoveryFields & ({ version: 1; localDisplayName?: never; syncPayload?: never; syncMinimum?: never } | { version: 2; localDisplayName: string | null; syncPayload?: never; syncMinimum?: never } | { version: 3; localDisplayName?: string | null; syncPayload: SyncPayloadV2; syncMinimum: 1 | 2 });

export const MAX_RECOVERY_BYTES = 512 * 1024;
export const MAX_RECOVERY_FILE_BYTES = 704 * 1024;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const encoder = new TextEncoder();

function invalid(): never { throw new Error('Invalid or unsupported recovery file'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS.test(value)) invalid();
  return value.toLowerCase();
}
function string(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) invalid();
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) invalid();
  return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 1000) invalid();
  return value.map(parse);
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) invalid();
  return items;
}

/** Strict allowlist: unknown fields are rejected, never silently exported or discarded. */
export function validateRecoveryData(value: unknown): RecoveryData {
  const version = value && typeof value === 'object' ? (value as Record<string, unknown>).version : undefined;
  const hasLabel = version === 2 || version === 3 && Object.hasOwn(value as object, 'localDisplayName');
  const data = object(value, ['version', 'source', 'wallet', 'createdAt', 'contacts', 'notes', 'preferences', ...(hasLabel ? ['localDisplayName'] : []), ...(version === 3 ? ['syncPayload', 'syncMinimum'] : [])]);
  if (![1, 2, 3].includes(data.version as number) || !['chirpy', 'governance', 'research'].includes(data.source as string)) invalid();
  if ((hasLabel || version === 3) && (data.source !== 'chirpy' || (hasLabel && data.localDisplayName !== null && !validWalletLabel(data.localDisplayName)))) invalid();
  if (version === 3 && data.syncMinimum !== 1 && data.syncMinimum !== 2) invalid();
  const prefs = object(data.preferences, ['blocked', 'readReceiptsDefault', 'readReceiptOverrides']);
  if (typeof prefs.readReceiptsDefault !== 'boolean') invalid();
  const overrides = prefs.readReceiptOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || Object.getPrototypeOf(overrides) !== Object.prototype || Object.keys(overrides).length > 1000) invalid();
  for (const [key, on] of Object.entries(overrides)) {
    if (!/^(mock|xmtp):(dev|production):[a-zA-Z0-9_-]{1,256}$/.test(key) || typeof on !== 'boolean') invalid();
  }
  const result: RecoveryData = {
    ...(version === 3 ? { version: 3 as const, syncPayload: parseSyncPayloadV2(data.syncPayload), syncMinimum: data.syncMinimum as 1 | 2, ...(hasLabel ? { localDisplayName: data.localDisplayName as string | null } : {}) } : version === 2 ? { version: 2 as const, localDisplayName: data.localDisplayName as string | null } : { version: 1 as const }),
    source: data.source as RecoveryData['source'], wallet: address(data.wallet), createdAt: timestamp(data.createdAt),
    contacts: unique(list(data.contacts, item => {
      const contact = object(item, ['address', 'label']);
      return { address: address(contact.address), label: string(contact.label, 200) };
    }), contact => contact.address),
    notes: unique(list(data.notes, item => {
      const note = object(item, ['id', 'text', 'sentAtMs']);
      return { id: string(note.id, 256, 1), text: string(note.text, 50_000), sentAtMs: timestamp(note.sentAtMs) };
    }), note => note.id),
    preferences: {
      blocked: unique(list(prefs.blocked, address), item => item),
      readReceiptsDefault: prefs.readReceiptsDefault,
      readReceiptOverrides: { ...overrides } as Record<string, boolean>,
    },
  };
  if (result.version === 3 && !samePreferences({ ...result.preferences, syncAcrossDevices: result.syncPayload.syncAcrossDevices.value }, syncPayloadV2View(result.syncPayload).settingsPrefs)) invalid();
  if (encoder.encode(JSON.stringify(result)).length > MAX_RECOVERY_BYTES) invalid();
  return result;
}

const cipher = recoveryCipher('chat-recovery', 'Chat recovery v1;AES-256-GCM;PBKDF2-SHA-256;600000',
  {bytes: MAX_RECOVERY_BYTES, fileBytes: MAX_RECOVERY_FILE_BYTES});
export async function encryptRecoveryArchive(value: unknown, password: string): Promise<string> {
  return cipher.encrypt(validateRecoveryData(value), password);
}
/** expectedWallet must come from the caller's verified wallet session, never from the file. */
export async function decryptRecoveryArchive(raw: string, password: string, expectedWallet: string): Promise<RecoveryData> {
  const wallet = address(expectedWallet);
  const data = validateRecoveryData(await cipher.decrypt(raw, password));
  if (data.wallet !== wallet) throw new Error('Recovery file belongs to a different wallet');
  return data;
}
