import { validateRecoveryData, type RecoveryData } from './recoveryArchive';

export type Contact = RecoveryData['contacts'][number];
export type LocalNote = RecoveryData['notes'][number];
export interface LocalData {
  version: 1;
  wallet: string;
  revision: number;
  contacts: Contact[];
  notes: LocalNote[];
}
export type LocalChange =
  | { kind: 'contact'; before: Contact | null; after: Contact | null }
  | { kind: 'note'; before: LocalNote | null; after: LocalNote | null };
export class LocalDataConflict extends Error {}
const DATABASE = 'chat-local-data-v1';
const STORE = 'wallets';
const EVENT = 'chat-local-data-changed';

function owner(wallet: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Invalid local data wallet');
  return wallet.toLowerCase();
}
export function emptyLocalData(wallet: string): LocalData {
  return { version: 1, wallet: owner(wallet), revision: 0, contacts: [], notes: [] };
}
/** Never replace malformed or newer-version data with an empty state. */
export function validateLocalData(value: unknown, wallet: string): LocalData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local data');
  const data = value as LocalData;
  const keys = ['version', 'wallet', 'revision', 'contacts', 'notes'];
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))
    || data.version !== 1 || data.wallet !== owner(wallet) || !Number.isSafeInteger(data.revision)
    || data.revision < 0 || data.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid local data');
  const parsed = validateRecoveryData({ version: 1, source: 'chirpy', wallet: data.wallet, createdAt: 0,
    contacts: data.contacts, notes: data.notes,
    preferences: { blocked: [], readReceiptsDefault: false, readReceiptOverrides: {} } });
  return { version: 1, wallet: parsed.wallet, revision: data.revision, contacts: parsed.contacts, notes: parsed.notes };
}

/** Compare the edited item, not a stale whole-list snapshot, inside the write transaction. */
export function applyLocalChange(value: LocalData, change: LocalChange): LocalData {
  const data = validateLocalData(value, value.wallet);
  const before = change.before; const after = change.after;
  if (!before && !after) throw new Error('Empty local data change');
  if (change.kind === 'contact') {
    const prior = before as Contact | null; const next = after as Contact | null;
    const address = owner((prior ?? next)!.address);
    if (next && owner(next.address) !== address) throw new Error('Contact address cannot change');
    const index = data.contacts.findIndex(item => item.address === address);
    const current = data.contacts[index];
    if (prior ? !current || current.label !== prior.label : current) throw new LocalDataConflict('Contact changed');
    if (next) {
      if (index < 0) data.contacts.push(next); else data.contacts[index] = next;
    } else if (index >= 0) data.contacts.splice(index, 1);
  } else if (change.kind === 'note') {
    const prior = before as LocalNote | null; const next = after as LocalNote | null;
    const id = (prior ?? next)!.id;
    if (next && next.id !== id) throw new Error('Note id cannot change');
    const index = data.notes.findIndex(item => item.id === id); const current = data.notes[index];
    if (prior ? !current || current.text !== prior.text || current.sentAtMs !== prior.sentAtMs : current) {
      throw new LocalDataConflict('Note changed');
    }
    if (next) {
      if (index < 0) data.notes.push(next); else data.notes[index] = next;
    } else if (index >= 0) data.notes.splice(index, 1);
  } else throw new Error('Unsupported local data change');
  data.revision++;
  return validateLocalData(data, data.wallet);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let settled = false;
    const fail = () => { settled = true; reject(new Error('Local storage unavailable')); };
    const timer = setTimeout(fail, 10_000);
    request.onblocked = () => { clearTimeout(timer); fail(); };
    request.onerror = () => { clearTimeout(timer); fail(); };
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return; }
      request.result.createObjectStore(STORE, { keyPath: 'wallet' });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

/** Resolves only on commit. A failed read/validation/write aborts without changing the record. */
async function transact(wallet: string, change?: LocalChange, ensureCurrent: () => void = () => {}): Promise<LocalData> {
  const address = owner(wallet);
  ensureCurrent();
  const db = await openDatabase();
  try {
    ensureCurrent();
    return await new Promise<LocalData>((resolve, reject) => {
      const tx = db.transaction(STORE, change ? 'readwrite' : 'readonly');
      const timer = setTimeout(() => {
        try { tx.abort(); } catch { /* Transaction already settled. */ }
      }, 10_000);
      const store = tx.objectStore(STORE);
      let result: LocalData; let failure: unknown;
      const request = store.get(address);
      request.onsuccess = () => {
        try {
          ensureCurrent();
          result = request.result === undefined ? emptyLocalData(address) : validateLocalData(request.result, address);
          if (change) { result = applyLocalChange(result, change); store.put(result); }
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.onabort = () => { clearTimeout(timer); reject(failure ?? tx.error ?? new Error('Local storage write aborted')); };
      tx.onerror = () => { /* The abort event settles the operation, including quota errors. */ };
      tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
    });
  } finally { db.close(); }
}
export const readLocalData = (wallet: string) => transact(wallet);
export async function changeLocalData(wallet: string, change: LocalChange, ensureCurrent: () => void) {
  // Copy before waiting for a database lock: callers cannot change the intended operation later.
  const snapshot = structuredClone(change);
  const data = await transact(wallet, snapshot, ensureCurrent);
  window.dispatchEvent(new Event(EVENT));
  try {
    const channel = new BroadcastChannel(EVENT); channel.postMessage('changed'); channel.close();
  } catch { /* Visibility/focus refresh remains available when BroadcastChannel is unavailable. */ }
  return data;
}
export function subscribeLocalData(refresh: () => void) {
  const visible = () => { if (document.visibilityState === 'visible') refresh(); };
  window.addEventListener(EVENT, refresh); window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', visible);
  let channel: BroadcastChannel | undefined;
  try { channel = new BroadcastChannel(EVENT); channel.onmessage = refresh; } catch { /* Optional refresh signal. */ }
  return () => {
    window.removeEventListener(EVENT, refresh); window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', visible); channel?.close();
  };
}
