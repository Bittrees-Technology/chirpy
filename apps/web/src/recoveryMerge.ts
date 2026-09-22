import { validateLocalData, type Contact, type LocalData, type LocalNote } from './localData';
import { validateRecoveryData } from './recoveryArchive';

export interface RecoveryConflict {
  kind: 'contact' | 'note';
  id: string;
  existing: Contact | LocalNote;
  incoming: Contact | LocalNote;
}
export interface RecoveryMerge {
  data: LocalData;
  addedContacts: number;
  addedNotes: number;
  unchanged: number;
  replaced: number;
  conflicts: RecoveryConflict[];
}
/** Empty/missing entries never mean deletion. Choices only apply to displayed conflicts. */
export function planLocalRecovery(current: LocalData, input: unknown, replace: readonly { kind: 'contact' | 'note'; id: string }[] = []): RecoveryMerge {
  const data = validateLocalData(current, current.wallet);
  const incoming = validateRecoveryData(input);
  if (incoming.wallet !== data.wallet) throw new Error('Recovery file belongs to a different wallet');
  if (!Array.isArray(replace) || replace.length > 2000) throw new Error('Invalid recovery choices');
  const choices = new Set<string>();
  for (const choice of replace) {
    if (!choice || !['contact', 'note'].includes(choice.kind) || typeof choice.id !== 'string'
      || Object.keys(choice).length !== 2 || !Object.hasOwn(choice, 'kind') || !Object.hasOwn(choice, 'id')) throw new Error('Invalid recovery choice');
    const key = `${choice.kind}:${choice.id}`;
    if (choices.has(key)) throw new Error('Duplicate recovery choice');
    choices.add(key);
  }
  const result: RecoveryMerge = { data, addedContacts: 0, addedNotes: 0, unchanged: 0, replaced: 0, conflicts: [] };
  for (const contact of incoming.contacts) {
    const index = data.contacts.findIndex(item => item.address === contact.address);
    if (index < 0) { data.contacts.push(contact); result.addedContacts++; continue; }
    const existing = data.contacts[index];
    if (existing.label === contact.label) { result.unchanged++; continue; }
    result.conflicts.push({ kind: 'contact', id: contact.address, existing: { ...existing }, incoming: { ...contact } });
    if (choices.delete(`contact:${contact.address}`)) { data.contacts[index] = contact; result.replaced++; }
  }
  for (const note of incoming.notes) {
    const index = data.notes.findIndex(item => item.id === note.id);
    if (index < 0) { data.notes.push(note); result.addedNotes++; continue; }
    const existing = data.notes[index];
    if (existing.text === note.text && existing.sentAtMs === note.sentAtMs) { result.unchanged++; continue; }
    result.conflicts.push({ kind: 'note', id: note.id, existing: { ...existing }, incoming: { ...note } });
    if (choices.delete(`note:${note.id}`)) { data.notes[index] = note; result.replaced++; }
  }
  if (choices.size) throw new Error('Recovery choice no longer matches a conflict');
  result.data = validateLocalData(data, data.wallet);
  return result;
}

/** Receipt sharing requires a separate opt-in; legacy blocks can only be added by import. */
export function planRecoveryPreferences(
  wallet: string,
  current: import('./recoveryArchive').RecoveryData['preferences'],
  input: unknown,
  choice: { restoreReceipts: boolean; addLegacyBlocks: boolean },
) {
  const incoming = validateRecoveryData(input);
  const checked = validateRecoveryData({ version: 1, source: 'chirpy', wallet, createdAt: 0,
    contacts: [], notes: [], preferences: current });
  if (checked.wallet !== incoming.wallet) throw new Error('Recovery file belongs to a different wallet');
  if (!choice || Object.keys(choice).length !== 2 || typeof choice.restoreReceipts !== 'boolean'
    || typeof choice.addLegacyBlocks !== 'boolean' || !Object.hasOwn(choice, 'restoreReceipts') || !Object.hasOwn(choice, 'addLegacyBlocks')) throw new Error('Invalid preference recovery choice');
  const preferences = {
    blocked: choice.addLegacyBlocks ? [...new Set([...checked.preferences.blocked, ...incoming.preferences.blocked])] : checked.preferences.blocked,
    readReceiptsDefault: choice.restoreReceipts ? incoming.preferences.readReceiptsDefault : checked.preferences.readReceiptsDefault,
    readReceiptOverrides: choice.restoreReceipts
      ? { ...checked.preferences.readReceiptOverrides, ...incoming.preferences.readReceiptOverrides }
      : checked.preferences.readReceiptOverrides,
  };
  return validateRecoveryData({ ...checked, preferences }).preferences;
}
