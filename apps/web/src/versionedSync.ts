/** Versioned encrypted-settings model. Deletions are explicit, permanent
 * tombstones. This module never reads storage, signs, encrypts or sends data. */
export interface SyncStamp<T> { updatedAt: number; value: T }
export type SyncMessage = { id: string; [key: string]: unknown };
export interface SyncPayloadV2 {
  version: 2;
  readReceiptsDefault: SyncStamp<boolean>;
  syncAcrossDevices: SyncStamp<boolean>;
  readReceiptOverrides: Record<string, SyncStamp<boolean | null>>;
  blocked: Record<string, SyncStamp<boolean>>;
  savedMessages: Record<string, SyncStamp<SyncMessage | null>>;
  updatedAt: number;
}
export type SyncChange =
  | { kind: 'readReceiptsDefault' | 'syncAcrossDevices'; value: boolean }
  | { kind: 'readReceiptOverride'; key: string; value: boolean | null }
  | { kind: 'block'; address: string; value: boolean }
  | { kind: 'savedMessage'; id: string; value: SyncMessage | null };
const MAX_BYTES = 300000, MAX_ENTRIES = 10000;
const address = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);
const receiptKey = (value: string) => /^(mock|xmtp):(dev|production):[a-zA-Z0-9_-]{1,256}$/.test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
function fail(): never { throw Error('Invalid or unsupported versioned sync data. Existing data must be preserved.'); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function bounded(value: unknown) {
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(value)).length; } catch { return fail(); }
  if (bytes > MAX_BYTES) fail();
}
/** Preserve arbitrary JSON message fields, with canonical order and safe keys. */
function json(value: unknown, depth = 0): any {
  if (depth > 64) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (Array.isArray(value)) { if (value.length > MAX_ENTRIES) fail(); return value.map(item => json(item, depth + 1)); }
  if (!object(value) || Object.keys(value).length > MAX_ENTRIES) return fail();
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, json(value[key], depth + 1)]));
}
const canonical = (value: unknown) => JSON.stringify(json(value));
function message(value: unknown, id: string): SyncMessage | null {
  if (value === null) return null;
  if (!object(value) || value.id !== id || (Object.hasOwn(value, 'updatedAt') && !time(value.updatedAt))) return fail();
  return json(value) as SyncMessage;
}
function stamp<T>(value: unknown, parse: (value: unknown) => T): SyncStamp<T> {
  exact(value, ['updatedAt', 'value']); if (!time(value.updatedAt)) fail();
  return { updatedAt: value.updatedAt, value: parse(value.value) };
}
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : fail();
const nullableBool = (value: unknown): boolean | null => value === null ? null : bool(value);
function entries<T>(value: unknown, validKey: (key: string) => boolean, parse: (value: unknown, key: string) => T): Record<string, SyncStamp<T>> {
  if (!object(value) || Object.keys(value).length > MAX_ENTRIES) return fail();
  return Object.fromEntries(Object.keys(value).sort().map(key => {
    if (!validKey(key)) fail(); return [key, stamp(value[key], value => parse(value, key))];
  }));
}
const id = (value: string) => value.length > 0 && value.length <= MAX_BYTES;
function newest(value: Omit<SyncPayloadV2, 'updatedAt'>) {
  let result = Math.max(value.readReceiptsDefault.updatedAt, value.syncAcrossDevices.updatedAt);
  for (const map of [value.readReceiptOverrides, value.blocked, value.savedMessages]) for (const item of Object.values(map)) result = Math.max(result, item.updatedAt);
  return result;
}
function complete(value: Omit<SyncPayloadV2, 'updatedAt'>): SyncPayloadV2 {
  const result = { ...value, updatedAt: newest(value) }; bounded(result); return result;
}
export function parseSyncPayloadV2(value: unknown): SyncPayloadV2 {
  bounded(value); exact(value, ['version', 'readReceiptsDefault', 'syncAcrossDevices', 'readReceiptOverrides', 'blocked', 'savedMessages', 'updatedAt']);
  if (value.version !== 2 || !time(value.updatedAt)) fail();
  const result = complete({ version: 2,
    readReceiptsDefault: stamp(value.readReceiptsDefault, bool), syncAcrossDevices: stamp(value.syncAcrossDevices, bool),
    readReceiptOverrides: entries(value.readReceiptOverrides, receiptKey, nullableBool),
    blocked: entries(value.blocked, key => address(key) && key === key.toLowerCase(), bool),
    savedMessages: entries(value.savedMessages, id, message),
  });
  if (result.updatedAt !== value.updatedAt) fail(); return result;
}
function winner<T>(a: SyncStamp<T>, b: SyncStamp<T>, equal: (a: T, b: T) => T): SyncStamp<T> {
  return a.updatedAt > b.updatedAt ? a : b.updatedAt > a.updatedAt ? b : { updatedAt: a.updatedAt, value: equal(a.value, b.value) };
}
function mergeMap<T>(a: Record<string, SyncStamp<T>>, b: Record<string, SyncStamp<T>>, equal: (a: T, b: T) => T) {
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map(key => {
    const left = Object.hasOwn(a, key) ? a[key] : undefined, right = Object.hasOwn(b, key) ? b[key] : undefined;
    return [key, left && right ? winner(left, right, equal) : left ?? right!];
  }));
}
const equalMessage = (a: SyncMessage | null, b: SyncMessage | null) => a === null || b === null ? null : canonical(a) >= canonical(b) ? a : b;
/** At equal clocks, receipt conflicts resolve off; blocks stay blocked and
 * message deletions win. Null override means an explicit reset to the default. */
export function mergeSyncPayloadV2(left: unknown, right: unknown): SyncPayloadV2 {
  const a = parseSyncPayloadV2(left), b = parseSyncPayloadV2(right);
  return complete({ version: 2,
    readReceiptsDefault: winner(a.readReceiptsDefault, b.readReceiptsDefault, (a, b) => a && b),
    syncAcrossDevices: winner(a.syncAcrossDevices, b.syncAcrossDevices, (a, b) => a && b),
    readReceiptOverrides: mergeMap(a.readReceiptOverrides, b.readReceiptOverrides, (a, b) => a === b ? a : false),
    blocked: mergeMap(a.blocked, b.blocked, (a, b) => a || b),
    savedMessages: mergeMap(a.savedMessages, b.savedMessages, equalMessage),
  });
}
/** Only first-upgrade inputs belong here. Do not reimport legacy snapshots
 * after an upgraded record has become authoritative. */
export function upgradeSyncPayloadV1(value: unknown): SyncPayloadV2 {
  bounded(value); exact(value, ['version', 'settingsPrefs', 'savedMessages', 'updatedAt']);
  if (value.version !== 1 || !time(value.updatedAt) || !object(value.settingsPrefs) || !Array.isArray(value.savedMessages) || value.savedMessages.length > MAX_ENTRIES) fail();
  const prefs = value.settingsPrefs;
  exact(prefs, ['readReceiptsDefault', 'syncAcrossDevices', 'blocked', ...(Object.hasOwn(prefs, 'readReceiptOverrides') ? ['readReceiptOverrides'] : [])]);
  const at = value.updatedAt, overrides = prefs.readReceiptOverrides ?? {};
  if (!object(overrides) || Object.keys(overrides).length > MAX_ENTRIES || !Array.isArray(prefs.blocked) || prefs.blocked.length > MAX_ENTRIES) fail();
  const messages = new Map<string, SyncStamp<SyncMessage | null>>();
  for (const item of value.savedMessages) {
    if (!object(item) || typeof item.id !== 'string' || !id(item.id)) fail();
    const next = { value: message(item, item.id), updatedAt: Object.hasOwn(item, 'updatedAt') ? item.updatedAt as number : at };
    const prior = messages.get(item.id); messages.set(item.id, prior ? winner(prior, next, equalMessage) : next);
  }
  return complete({ version: 2, readReceiptsDefault: { value: bool(prefs.readReceiptsDefault), updatedAt: at }, syncAcrossDevices: { value: bool(prefs.syncAcrossDevices), updatedAt: at },
    readReceiptOverrides: Object.fromEntries(Object.keys(overrides).sort().map(key => { if (!receiptKey(key)) fail(); return [key, { value: bool(overrides[key]), updatedAt: at }]; })),
    blocked: Object.fromEntries([...new Set(prefs.blocked.map(wallet => { if (typeof wallet !== 'string' || !address(wallet)) return fail(); return wallet.toLowerCase(); }))].sort().map(wallet => [wallet, { value: true, updatedAt: at }])),
    savedMessages: Object.fromEntries([...messages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  });
}
export function editSyncPayloadV2(value: unknown, change: SyncChange, now = Date.now()): SyncPayloadV2 {
  const payload = parseSyncPayloadV2(value); if (!time(now)) fail();
  const updatedAt = Math.max(now, payload.updatedAt + 1); if (!time(updatedAt)) fail();
  if (change.kind === 'readReceiptsDefault' || change.kind === 'syncAcrossDevices') {
    exact(change, ['kind', 'value']); payload[change.kind] = { updatedAt, value: bool(change.value) };
  } else if (change.kind === 'readReceiptOverride') {
    exact(change, ['kind', 'key', 'value']); if (!receiptKey(change.key)) fail();
    payload.readReceiptOverrides = { ...payload.readReceiptOverrides, [change.key]: { updatedAt, value: nullableBool(change.value) } };
  } else if (change.kind === 'block') {
    exact(change, ['kind', 'address', 'value']); if (!address(change.address)) fail();
    payload.blocked = { ...payload.blocked, [change.address.toLowerCase()]: { updatedAt, value: bool(change.value) } };
  } else if (change.kind === 'savedMessage') {
    exact(change, ['kind', 'id', 'value']); if (!id(change.id)) fail();
    payload.savedMessages = { ...payload.savedMessages, [change.id]: { updatedAt, value: message(change.value, change.id) } };
  } else return fail();
  return parseSyncPayloadV2({ ...payload, updatedAt });
}
/** A view for controls, never an input for regenerating an upgraded payload. */
export function syncPayloadV2View(value: unknown) {
  const payload = parseSyncPayloadV2(value);
  return { settingsPrefs: { readReceiptsDefault: payload.readReceiptsDefault.value, syncAcrossDevices: payload.syncAcrossDevices.value,
    readReceiptOverrides: Object.fromEntries(Object.entries(payload.readReceiptOverrides).filter(([, item]) => item.value !== null).map(([key, item]) => [key, item.value as boolean])),
    blocked: Object.entries(payload.blocked).filter(([, item]) => item.value).map(([wallet]) => wallet),
  }, savedMessages: Object.values(payload.savedMessages).flatMap(item => item.value === null ? [] : [item.value]), updatedAt: payload.updatedAt };
}
