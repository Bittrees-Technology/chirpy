import { expect, it } from 'vitest';
import { backupArchive, validateJournal } from '../src/recoveryJournal';
import { emptyLocalData } from '../src/localData';
import { defaultSettings, serializeSettings } from '../src/settingsStorage';
const owner = '0x1111111111111111111111111111111111111111';
function journal() {
  const before = emptyLocalData(owner);
  return { wallet: `restore:${owner}`, owner, version: 1, id: '00000000-0000-4000-8000-000000000001', createdAt: 1,
    source: 'chirpy', phase: 'prepared', before, after: { ...before, revision: 1 }, beforePrefs: null,
    afterPrefs: serializeSettings(defaultSettings(), 1), undoPrefs: serializeSettings(defaultSettings(), 2) };
}
it('validates bounded snapshots and exports a credentials-free pre-restore archive', () => {
  const data = validateJournal(journal(), owner);
  expect(backupArchive(data)).toMatchObject({ wallet: owner, contacts: [], notes: [], preferences: { readReceiptsDefault: false } });
  expect(backupArchive(data).preferences).not.toHaveProperty('syncAcrossDevices');
});
it('rejects wrong-owner, unknown fields, invalid phases and impossible undo revisions', () => {
  const data = journal();
  for (const bad of [{ ...data, owner: '0x2222222222222222222222222222222222222222' }, { ...data, phase: 'done' },
    { ...data, credential: 'forbidden' }, { ...data, after: { ...data.after, revision: 4 } },
    { ...data, before: { ...data.before, revision: Number.MAX_SAFE_INTEGER - 2 }, after: { ...data.after, revision: Number.MAX_SAFE_INTEGER - 1 } }]) {
    expect(() => validateJournal(bad, owner)).toThrow();
  }
});
it('never lets journal apply or undo enable sync or alter the promised undo preferences', () => {
  const data = journal();
  for (const bad of [{ ...data, afterPrefs: serializeSettings({ ...defaultSettings(), syncAcrossDevices: true }, 1) },
    { ...data, undoPrefs: serializeSettings({ ...defaultSettings(), readReceiptsDefault: true }, 2) },
    { ...data, beforePrefs: '{bad' }]) expect(() => validateJournal(bad, owner)).toThrow();
});
