import { emptyLocalData, localRecords, notifyLocalData, validateLocalData, type LocalData } from './localData';
import { validateRecoveryData, type RecoveryData } from './recoveryArchive';
import { assertNoRecoveryPending, parseSettingsRaw, recoveryMarkerKey, serializeSettings, walletSettingsKey, withSettingsLock } from './settingsStorage';

export interface RecoveryJournal {
  wallet: string; // Reserved IndexedDB key; never a wallet authority claim.
  owner: string;
  version: 1;
  id: string;
  createdAt: number;
  source: RecoveryData['source'];
  phase: 'prepared' | 'applied' | 'undoing' | 'undone' | 'abandoned';
  before: LocalData;
  after: LocalData;
  beforePrefs: string | null;
  afterPrefs: string;
  undoPrefs: string;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const journalKey = (wallet: string) => `restore:${wallet.toLowerCase()}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function conflict(): never { throw new Error('Recovery state changed; existing data and backup were preserved'); }

export function backupArchive(journal: RecoveryJournal): RecoveryData {
  const prefs = parseSettingsRaw(journal.beforePrefs).prefs;
  return validateRecoveryData({ version: 1, source: 'chirpy', wallet: journal.owner, createdAt: journal.createdAt,
    contacts: journal.before.contacts, notes: journal.before.notes,
    preferences: { blocked: prefs.blocked, readReceiptsDefault: prefs.readReceiptsDefault, readReceiptOverrides: prefs.readReceiptOverrides ?? {} } });
}
export function validateJournal(value: unknown, wallet: string): RecoveryJournal {
  const owner = wallet.toLowerCase(); walletSettingsKey(owner);
  if (!value || typeof value !== 'object' || Array.isArray(value)) conflict();
  const data = value as RecoveryJournal;
  const keys = ['wallet', 'owner', 'version', 'id', 'createdAt', 'source', 'phase', 'before', 'after', 'beforePrefs', 'afterPrefs', 'undoPrefs'];
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))
    || data.wallet !== journalKey(owner) || data.owner !== owner || data.version !== 1 || !uuid.test(data.id)
    || !Number.isSafeInteger(data.createdAt) || data.createdAt < 0 || data.createdAt > 8_640_000_000_000_000
    || !['chirpy', 'governance', 'research'].includes(data.source)
    || !['prepared', 'applied', 'undoing', 'undone', 'abandoned'].includes(data.phase)) conflict();
  const before = validateLocalData(data.before, owner); const after = validateLocalData(data.after, owner);
  if (after.revision !== before.revision + 1) conflict();
  if (typeof data.afterPrefs !== 'string' || typeof data.undoPrefs !== 'string') conflict();
  const afterPrefs = parseSettingsRaw(data.afterPrefs).prefs;
  const undoPrefs = parseSettingsRaw(data.undoPrefs).prefs;
  const beforePrefs = parseSettingsRaw(data.beforePrefs).prefs;
  if (afterPrefs.syncAcrossDevices || undoPrefs.syncAcrossDevices
    || serializeSettings(undoPrefs, 0) !== serializeSettings({ ...beforePrefs, syncAcrossDevices: false }, 0)) conflict();
  validateLocalData({ ...before, revision: after.revision + 1 }, owner);
  const result = { ...data, before, after };
  backupArchive(result);
  validateRecoveryData({ version: 1, source: data.source, wallet: owner, createdAt: data.createdAt,
    contacts: after.contacts, notes: after.notes, preferences: {
      blocked: afterPrefs.blocked, readReceiptsDefault: afterPrefs.readReceiptsDefault, readReceiptOverrides: afterPrefs.readReceiptOverrides ?? {},
    } });
  return result;
}
export async function readRecoveryJournal(wallet: string) {
  walletSettingsKey(wallet);
  return localRecords([journalKey(wallet)], false, ([raw]) => ({ result: raw === undefined ? null : validateJournal(raw, wallet) }));
}
export function recoveryPending(wallet: string) { return localStorage.getItem(recoveryMarkerKey(walletSettingsKey(wallet))) !== null; }
function markPending(journal: RecoveryJournal) {
  const key = recoveryMarkerKey(walletSettingsKey(journal.owner)); const marker = localStorage.getItem(key);
  if (marker !== null && marker !== `v1:${journal.id}`) conflict();
  localStorage.setItem(key, `v1:${journal.id}`);
}

/** First persist a complete before/after journal. No user records change in this preparation. */
export async function prepareRecovery(wallet: string, before: LocalData, beforePrefs: string | null,
  after: LocalData, preferences: RecoveryData['preferences'], source: RecoveryData['source'], ensureCurrent: () => void) {
  const key = walletSettingsKey(wallet); const owner = wallet.toLowerCase();
  const createdAt = Date.now(); const priorTime = parseSettingsRaw(beforePrefs).updatedAt;
  const journal = validateJournal({ wallet: journalKey(owner), owner, version: 1, id: crypto.randomUUID(), createdAt, source,
    phase: 'prepared', before, after: { ...after, revision: before.revision + 1 }, beforePrefs,
    afterPrefs: serializeSettings({ ...preferences, syncAcrossDevices: false }, Math.max(createdAt, priorTime + 1)),
    undoPrefs: serializeSettings({ ...parseSettingsRaw(beforePrefs).prefs, syncAcrossDevices: false }, Math.max(createdAt + 1, priorTime + 2)),
  }, owner);
  return withSettingsLock(key, async () => {
    ensureCurrent(); assertNoRecoveryPending(key);
    if (await readRecoveryJournal(owner)) conflict();
    ensureCurrent();
    if (localStorage.getItem(key) !== beforePrefs) conflict();
    markPending(journal);
    try {
      return await localRecords([owner, journal.wallet], true, ([raw, previous]) => {
        const current = raw === undefined ? emptyLocalData(owner) : validateLocalData(raw, owner);
        if (previous !== undefined || !equal(current, journal.before) || localStorage.getItem(key) !== beforePrefs) conflict();
        return { result: journal, put: [journal] };
      }, ensureCurrent);
    } catch (error) {
      // A rejected IndexedDB transaction committed no journal or data. Clear only our own marker.
      if (localStorage.getItem(recoveryMarkerKey(key)) === `v1:${journal.id}`) localStorage.removeItem(recoveryMarkerKey(key));
      throw error;
    }
  });
}

/** Idempotent reconciliation of the two stores; never overwrite an unrecognized later state. */
export async function continueRecovery(wallet: string, id: string, undo: boolean, ensureCurrent: () => void) {
  const key = walletSettingsKey(wallet); const owner = wallet.toLowerCase();
  return withSettingsLock(key, async () => {
    ensureCurrent();
    let journal = await readRecoveryJournal(owner);
    ensureCurrent();
    if (!journal || journal.id !== id || journal.phase === 'abandoned' || (!undo && ['undoing', 'undone'].includes(journal.phase))) conflict();
    const targetLocal = undo ? validateLocalData({ ...journal.before, revision: journal.after.revision + 1 }, owner) : journal.after;
    const targetPrefs = undo ? journal.undoPrefs : journal.afterPrefs;
    const allowedPrefs = undo ? [journal.beforePrefs, journal.afterPrefs, journal.undoPrefs] : [journal.beforePrefs, journal.afterPrefs];
    const allowedLocal = undo ? [journal.before, journal.after, targetLocal] : [journal.before, journal.after];
    // Refuse stale undo before placing a new marker; later edits must stay usable.
    await localRecords([owner, journal.wallet], false, ([raw, stored]) => {
      const current = raw === undefined ? emptyLocalData(owner) : validateLocalData(raw, owner);
      if (!equal(validateJournal(stored, owner), journal) || !allowedLocal.some(value => equal(current, value))
        || !allowedPrefs.includes(localStorage.getItem(key))) conflict();
      return { result: undefined };
    }, ensureCurrent);
    ensureCurrent(); markPending(journal);
    journal = await localRecords([owner, journal.wallet], true, ([raw, stored]) => {
      const current = raw === undefined ? emptyLocalData(owner) : validateLocalData(raw, owner);
      const saved = validateJournal(stored, owner);
      if (saved.id !== id || !equal(saved, journal) || !allowedLocal.some(value => equal(current, value))
        || !allowedPrefs.includes(localStorage.getItem(key))) conflict();
      const pending = { ...saved, phase: undo ? 'undoing' as const : 'prepared' as const };
      return { result: pending, put: [targetLocal, pending] };
    }, ensureCurrent);
    ensureCurrent();
    if (!allowedPrefs.includes(localStorage.getItem(key))) conflict();
    if (localStorage.getItem(key) !== targetPrefs) localStorage.setItem(key, targetPrefs);
    ensureCurrent();
    const completed = await localRecords([owner, journal.wallet], true, ([raw, stored]) => {
      const saved = validateJournal(stored, owner);
      if (saved.id !== id || !equal(saved, journal) || !equal(validateLocalData(raw, owner), targetLocal)
        || localStorage.getItem(key) !== targetPrefs) conflict();
      const done = { ...saved, phase: undo ? 'undone' as const : 'applied' as const };
      return { result: done, put: [done] };
    }, ensureCurrent);
    if (localStorage.getItem(recoveryMarkerKey(key)) !== `v1:${id}`) conflict();
    localStorage.removeItem(recoveryMarkerKey(key));
    notifyLocalData(); return completed;
  });
}
export async function discardRecoveryBackup(wallet: string, id: string, ensureCurrent: () => void) {
  const key = walletSettingsKey(wallet);
  return withSettingsLock(key, async () => {
    ensureCurrent(); assertNoRecoveryPending(key);
    await localRecords([journalKey(wallet)], true, ([raw]) => {
      const journal = validateJournal(raw, wallet);
      if (journal.id !== id || !['applied', 'undone', 'abandoned'].includes(journal.phase)) conflict();
      return { result: undefined, remove: [journal.wallet] };
    }, ensureCurrent);
  });
}
export async function clearUnpreparedRecovery(wallet: string, ensureCurrent: () => void) {
  const key = walletSettingsKey(wallet);
  return withSettingsLock(key, async () => {
    ensureCurrent();
    if (await readRecoveryJournal(wallet)) conflict();
    ensureCurrent();
    const marker = localStorage.getItem(recoveryMarkerKey(key));
    if (marker === null) return;
    if (!marker.startsWith('v1:') || !uuid.test(marker.slice(3))) conflict();
    localStorage.removeItem(recoveryMarkerKey(key));
  });
}

/** Explicitly stop reconciling a conflicted restore, retaining both current data and the backup. */
export async function abandonRecovery(wallet: string, id: string, ensureCurrent: () => void) {
  const key = walletSettingsKey(wallet); const owner = wallet.toLowerCase();
  return withSettingsLock(key, async () => {
    ensureCurrent();
    const marker = localStorage.getItem(recoveryMarkerKey(key));
    if (marker !== `v1:${id}`) conflict();
    await localRecords([owner, journalKey(owner)], true, ([raw, stored]) => {
      const journal = validateJournal(stored, owner);
      if (journal.id !== id) conflict();
      if (raw !== undefined) validateLocalData(raw, owner);
      parseSettingsRaw(localStorage.getItem(key));
      return { result: undefined, put: [{ ...journal, phase: 'abandoned' }] };
    }, ensureCurrent);
    ensureCurrent();
    if (localStorage.getItem(recoveryMarkerKey(key)) !== marker) conflict();
    localStorage.removeItem(recoveryMarkerKey(key)); notifyLocalData();
  });
}
