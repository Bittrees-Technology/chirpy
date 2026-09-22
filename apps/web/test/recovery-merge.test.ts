import { expect, it } from 'vitest';
import { emptyLocalData } from '../src/localData';
import { planLocalRecovery } from '../src/recoveryMerge';
import type { RecoveryData } from '../src/recoveryArchive';
const wallet = '0x1111111111111111111111111111111111111111';
const peer = '0x2222222222222222222222222222222222222222';
const existing = { ...emptyLocalData(wallet), contacts: [{ address: peer, label: 'My label' }], notes: [{ id: 'one', text: 'Keep', sentAtMs: 1 }] };
const archive = (): RecoveryData => ({ version: 1, source: 'chirpy', wallet, createdAt: 100, contacts: [], notes: [],
  preferences: { blocked: [], readReceiptsDefault: true, readReceiptOverrides: {} } });
it('does not infer deletions or preference consent from empty collections', () => {
  expect(planLocalRecovery(existing, archive())).toMatchObject({ data: existing, addedContacts: 0, addedNotes: 0, replaced: 0, conflicts: [] });
  expect(planLocalRecovery(existing, archive()).data).not.toHaveProperty('preferences');
});
it('adds independent entries and treats repeated imports as duplicates', () => {
  const input = { ...archive(), contacts: [{ address: wallet, label: 'Me' }], notes: [{ id: 'two', text: 'New', sentAtMs: 2 }] };
  const first = planLocalRecovery(existing, input);
  expect(first).toMatchObject({ addedContacts: 1, addedNotes: 1, unchanged: 0 });
  const second = planLocalRecovery(first.data, input);
  expect(second).toMatchObject({ addedContacts: 0, addedNotes: 0, unchanged: 2 });
  expect(existing.contacts).toHaveLength(1); expect(existing.notes).toHaveLength(1);
});
it('keeps conflicts by default and replaces only explicitly selected entries', () => {
  const input = { ...archive(), contacts: [{ address: peer, label: 'Imported' }], notes: [{ id: 'one', text: 'Imported note', sentAtMs: 2 }] };
  const first = planLocalRecovery(existing, input);
  expect(first.conflicts).toHaveLength(2); expect(first.data).toEqual(existing);
  const selected = planLocalRecovery(existing, input, [{ kind: 'contact', id: peer }]);
  expect(selected.replaced).toBe(1); expect(selected.data.contacts[0].label).toBe('Imported');
  expect(selected.data.notes).toEqual(existing.notes);
  const conflict = selected.conflicts[0].existing;
  if ('label' in conflict) conflict.label = 'Mutation';
  expect(existing.contacts[0].label).toBe('My label');
});
it('rejects wrong-wallet, stale and duplicate conflict choices', () => {
  expect(() => planLocalRecovery(existing, { ...archive(), wallet: peer })).toThrow('different wallet');
  expect(() => planLocalRecovery(existing, archive(), [{ kind: 'contact', id: peer }])).toThrow('no longer');
  expect(() => planLocalRecovery(existing, archive(), [{ kind: 'note', id: 'one' }, { kind: 'note', id: 'one' }])).toThrow('Duplicate');
});
it('validates the combined result and never silently truncates imports', () => {
  const full = { ...emptyLocalData(wallet), notes: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), text: 'x', sentAtMs: 1 })) };
  expect(() => planLocalRecovery(full, { ...archive(), notes: [{ id: 'more', text: 'x', sentAtMs: 1 }] })).toThrow();
  expect(full.notes).toHaveLength(1000);
});

import { planRecoveryPreferences } from '../src/recoveryMerge';
const privatePreferences = { blocked: [peer], readReceiptsDefault: false, readReceiptOverrides: { 'xmtp:production:existing': false } };
it('does not enable receipt sharing without an explicit preference choice', () => {
  expect(planRecoveryPreferences(wallet, privatePreferences, archive(), { restoreReceipts: false, addLegacyBlocks: false })).toEqual(privatePreferences);
});
it('adds legacy blocks without removing existing blocks or enabling receipts', () => {
  const input = archive(); input.preferences.blocked = [wallet];
  const prefs = planRecoveryPreferences(wallet, privatePreferences, input, { restoreReceipts: false, addLegacyBlocks: true });
  expect(prefs.blocked).toEqual([peer, wallet]); expect(prefs.readReceiptsDefault).toBe(false);
});
it('restores explicitly reviewed receipt choices without deleting unrelated overrides', () => {
  const input = archive(); input.preferences.readReceiptOverrides = { 'xmtp:production:imported': true };
  const prefs = planRecoveryPreferences(wallet, privatePreferences, input, { restoreReceipts: true, addLegacyBlocks: false });
  expect(prefs).toEqual({ ...privatePreferences, readReceiptsDefault: true,
    readReceiptOverrides: { 'xmtp:production:existing': false, 'xmtp:production:imported': true } });
  expect(prefs).not.toHaveProperty('syncAcrossDevices');
  expect(privatePreferences.readReceiptsDefault).toBe(false);
});
it('rejects wrong-wallet preferences and unsupported choices', () => {
  expect(() => planRecoveryPreferences(peer, privatePreferences, archive(), { restoreReceipts: true, addLegacyBlocks: true })).toThrow('different wallet');
  expect(() => planRecoveryPreferences(wallet, privatePreferences, archive(), { restoreReceipts: 'true', addLegacyBlocks: true } as any)).toThrow();
});
