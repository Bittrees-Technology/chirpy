import { expect, it } from 'vitest';
import { applyLocalChange, emptyLocalData, LocalDataConflict, validateLocalData } from '../src/localData';
const wallet = '0x1111111111111111111111111111111111111111';
const contact = { address: '0x2222222222222222222222222222222222222222', label: 'Private label' };
const note = { id: 'one', text: 'Original', sentAtMs: 42 };
it('adds independent items without mutating earlier snapshots', () => {
  const initial = emptyLocalData(wallet);
  const first = applyLocalChange(initial, { kind: 'contact', before: null, after: contact });
  const second = applyLocalChange(first, { kind: 'note', before: null, after: note });
  expect(initial.contacts).toEqual([]); expect(first.notes).toEqual([]);
  expect(second).toMatchObject({ revision: 2, contacts: [contact], notes: [note] });
});
it('rejects duplicate adds and stale updates or deletes instead of silently overwriting', () => {
  const first = applyLocalChange(emptyLocalData(wallet), { kind: 'contact', before: null, after: contact });
  const second = applyLocalChange(first, { kind: 'contact', before: contact, after: { ...contact, label: 'Changed' } });
  for (const before of [null, contact]) {
    expect(() => applyLocalChange(second, { kind: 'contact', before, after: contact })).toThrow(LocalDataConflict);
  }
  expect(() => applyLocalChange(second, { kind: 'contact', before: contact, after: null })).toThrow(LocalDataConflict);
  expect(second.contacts[0].label).toBe('Changed');
});
it('requires the exact previous note for editing or deleting and preserves its id', () => {
  const first = applyLocalChange(emptyLocalData(wallet), { kind: 'note', before: null, after: note });
  const second = applyLocalChange(first, { kind: 'note', before: note, after: { ...note, text: 'Changed' } });
  expect(() => applyLocalChange(second, { kind: 'note', before: note, after: null })).toThrow(LocalDataConflict);
  expect(() => applyLocalChange(first, { kind: 'note', before: note, after: { ...note, id: 'two' } })).toThrow();
  expect(applyLocalChange(second, { kind: 'note', before: second.notes[0], after: null }).notes).toEqual([]);
});
it('normalizes addresses but rejects cross-wallet and unsupported records', () => {
  const current = emptyLocalData(wallet);
  expect(() => validateLocalData(current, contact.address)).toThrow();
  for (const bad of [{ ...current, version: 2 }, { ...current, revision: -1 }, { ...current, revision: 1.5 },
    { ...current, revision: Number.MAX_SAFE_INTEGER }, { ...current, credentials: 'never' },
    { ...current, contacts: [contact, contact] }, { ...current, notes: [{ ...note, text: 3 }] }]) {
    expect(() => validateLocalData(bad, wallet)).toThrow();
  }
});
it('rejects oversize writes and address changes without changing existing records', () => {
  const current = applyLocalChange(emptyLocalData(wallet), { kind: 'contact', before: null, after: contact });
  expect(() => applyLocalChange(current, { kind: 'contact', before: contact, after: { ...contact, address: wallet } })).toThrow();
  expect(() => applyLocalChange(current, { kind: 'contact', before: contact, after: { ...contact, label: 'x'.repeat(201) } })).toThrow();
  expect(() => applyLocalChange(current, { kind: 'note', before: null, after: { ...note, text: 'x'.repeat(50001) } })).toThrow();
  expect(current.contacts).toEqual([contact]);
});
