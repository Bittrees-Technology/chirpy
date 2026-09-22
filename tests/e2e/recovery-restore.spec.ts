import { test, expect, injectSyntheticWallet } from './fixtures/wallet';
import type { Page } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import { encryptRecoveryArchive, decryptRecoveryArchive, MAX_RECOVERY_FILE_BYTES, type RecoveryData } from '../../apps/web/src/recoveryArchive';
const password = 'recovery acceptance passphrase';
const peer = '0x2222222222222222222222222222222222222222';
function archive(wallet: string): RecoveryData {
  return { version: 1, source: 'chirpy', wallet, createdAt: 1, contacts: [{ address: peer, label: 'Imported label' }],
    notes: [{ id: 'imported-note', text: 'Imported note', sentAtMs: 1 }],
    preferences: { blocked: [peer], readReceiptsDefault: true, readReceiptOverrides: { 'xmtp:production:dm': true } } };
}
async function connect(page: Page) {
  await page.goto('/'); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  const button = page.getByRole('button', { name: 'Connect wallet', exact: true });
  if (await button.isVisible()) await button.click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
}
async function upload(page: Page, data: RecoveryData, pass = password) {
  const raw = await encryptRecoveryArchive(data, password);
  await page.getByLabel('Encrypted recovery file', { exact: true }).setInputFiles({ name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(raw) });
  await page.getByLabel('Restore passphrase', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Unlock and review file', exact: true }).click();
}
async function review(page: Page, data: RecoveryData) {
  await upload(page, data); await page.getByRole('heading', { name: 'Review proposed changes' }).waitFor();
}
async function records(page: Page, wallet: string) {
  return page.evaluate(wallet => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('chat-local-data-v1', 1);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('wallets'); const store = tx.objectStore('wallets');
      const data = store.get(wallet.toLowerCase()); const journal = store.get(`restore:${wallet.toLowerCase()}`);
      tx.oncomplete = () => { db.close(); resolve({ data: data.result, journal: journal.result,
        prefs: localStorage.getItem(`chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`),
        marker: localStorage.getItem(`chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}:recovery-pending`) }); };
      tx.onabort = () => reject(tx.error);
    };
  }), wallet);
}
async function seed(page: Page, wallet: string, contacts: RecoveryData['contacts'], notes: RecoveryData['notes']) {
  await page.evaluate(({ wallet, contacts, notes }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('chat-local-data-v1', 1);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('wallets', 'readwrite');
      tx.objectStore('wallets').put({ wallet: wallet.toLowerCase(), version: 1, revision: 1, contacts, notes });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    };
  }), { wallet, contacts, notes });
}
async function apply(page: Page) {
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reviewed changes saved.' })).toBeVisible();
}

test('restores reviewed data without inferring receipt consent, retains a backup and supports undo', async ({ page, walletAddress }, testInfo) => {
  await connect(page); await review(page, archive(walletAddress));
  await expect(page.getByRole('checkbox', { name: /Apply receipt preferences/ })).not.toBeChecked();
  const decline = page.getByRole('button', { name: 'Decline', exact: true });
  if (await decline.isVisible()) await decline.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Review proposed changes' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('restore-review-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await apply(page);
  const after = await records(page, walletAddress);
  expect(after.data.notes).toEqual(archive(walletAddress).notes); expect(after.journal.phase).toBe('applied');
  expect(after.marker).toBeNull(); expect(after.journal.before.contacts).toEqual([]);
  expect(JSON.parse(after.prefs)).toMatchObject({ readReceiptsDefault: false, syncAcrossDevices: false, blocked: [] });
  await page.reload(); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Undo restore', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restore undone.' })).toBeVisible();
  const undone = await records(page, walletAddress);
  expect(undone.data.notes).toEqual([]); expect(undone.data.contacts).toEqual([]); expect(undone.journal.phase).toBe('undone');
  expect(JSON.parse(undone.prefs).syncAcrossDevices).toBe(false);
});

test('keeps conflicts by default, applies explicit replacements and exports the original backup', async ({ page, walletAddress }) => {
  await connect(page);
  const originalContact = { address: peer, label: 'Original label' };
  const originalNote = { id: 'imported-note', text: 'Original note', sentAtMs: 2 };
  await seed(page, walletAddress, [originalContact], [originalNote]);
  await review(page, archive(walletAddress));
  await expect(page.getByRole('button', { name: 'Apply reviewed changes', exact: true })).toBeDisabled();
  await page.locator('details').filter({ has: page.locator('summary', { hasText: peer }) }).locator('summary').first().click();
  await page.getByRole('checkbox', { name: 'Replace this existing value', exact: true }).check();
  await page.getByRole('checkbox', { name: /Apply receipt preferences/ }).check();
  await page.getByRole('checkbox', { name: /Add legacy blocked/ }).check();
  await apply(page);
  const state = await records(page, walletAddress);
  expect(state.data.contacts[0].label).toBe('Imported label'); expect(state.data.notes).toEqual([originalNote]);
  expect(JSON.parse(state.prefs)).toMatchObject({ readReceiptsDefault: true, blocked: [peer], syncAcrossDevices: false });
  await page.getByText('Save an encrypted copy of the pre-restore backup', { exact: true }).click();
  await page.getByLabel('Backup passphrase', { exact: true }).fill(password);
  await page.getByLabel('Confirm backup passphrase', { exact: true }).fill(password);
  const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download encrypted pre-restore backup' }).click();
  const download = await waiting; const stream = await download.createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const backup = await decryptRecoveryArchive(Buffer.concat(chunks).toString('utf8'), password, walletAddress);
  expect(backup.contacts).toEqual([originalContact]); expect(backup.notes).toEqual([originalNote]);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Discard retained backup' }).click();
  await expect(page.getByRole('button', { name: 'Unlock and review file' })).toBeVisible();
  const final = await records(page, walletAddress); expect(final.journal).toBeUndefined(); expect(final.data).toEqual(state.data);
});

for (const failure of ['preferences', 'finalize']) test(`resumes after ${failure} failure without duplicates or false completion`, async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress));
  await page.evaluate(({ failure, wallet }) => {
    if (failure === 'preferences') {
      const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
        if (key === `chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`) throw new DOMException('Full', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    } else {
      const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, ...args) {
        if (value?.phase === 'applied') throw new DOMException('Full', 'QuotaExceededError');
        return put.call(this, value, ...args);
      };
    }
  }, { failure, wallet: walletAddress });
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'An unfinished restore' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Reviewed changes saved.' })).toHaveCount(0);
  const pending = await records(page, walletAddress); expect(pending.journal.phase).toBe('prepared'); expect(pending.marker).not.toBeNull();
  await page.reload(); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Resume unfinished restore', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reviewed changes saved.' })).toBeVisible();
  const finished = await records(page, walletAddress); expect(finished.data.notes).toHaveLength(1);
  expect(finished.data.revision).toBe(pending.data.revision); expect(finished.marker).toBeNull(); expect(finished.journal.phase).toBe('applied');
});

test('refuses stale undo without locking or overwriting later edits', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress)); await apply(page);
  await seed(page, walletAddress, [], [{ id: 'later', text: 'Later edit', sentAtMs: 4 }]);
  const before = await records(page, walletAddress);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Undo restore', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  const after = await records(page, walletAddress); expect(after.data).toEqual(before.data); expect(after.marker).toBeNull();
  expect(after.journal).toEqual(before.journal);
});

test('rejects wrong wallets, damaged files and oversized files before storing a journal', async ({ page, walletAddress }) => {
  await connect(page); const before = await records(page, walletAddress);
  await upload(page, archive(peer));
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  await page.getByLabel('Encrypted recovery file', { exact: true }).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await page.getByLabel('Restore passphrase', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock and review file' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  await page.getByLabel('Encrypted recovery file', { exact: true }).setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(MAX_RECOVERY_FILE_BYTES + 1) });
  await page.getByLabel('Restore passphrase', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock and review file' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  expect(await records(page, walletAddress)).toEqual(before);
});

test('two tabs cannot apply competing reviews over each other', async ({ browser }) => {
  const context = await browser.newContext(); const wallet = await injectSyntheticWallet(context, generatePrivateKey());
  const one = await context.newPage(); const two = await context.newPage();
  try {
    await connect(one); await connect(two); await review(one, archive(wallet));
    const second = archive(wallet); second.notes = [{ id: 'other', text: 'Other tab', sentAtMs: 1 }];
    await review(two, second);
    await Promise.all([one.getByRole('button', { name: 'Apply reviewed changes' }).click(), two.getByRole('button', { name: 'Apply reviewed changes' }).click()]);
    await expect.poll(async () => (await records(one, wallet)).journal?.phase).toBe('applied');
    const state = await records(one, wallet); expect(state.data.notes).toHaveLength(1);
    expect(state.journal.before.notes).toEqual([]); expect(state.journal.after.notes).toEqual(state.data.notes); expect(state.marker).toBeNull();
  } finally { await context.close(); }
});

test('cancels an apply queued behind another tab when the wallet disconnects', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress));
  const before = await records(page, walletAddress);
  await page.evaluate(wallet => new Promise<void>(resolve => {
    void navigator.locks.request(`chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}:write`, () => new Promise<void>(release => {
      (window as any).__releaseRecoveryLock = release; resolve();
    }));
  }), walletAddress);
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Checking recovery…' })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.evaluate(() => (window as any).__releaseRecoveryLock());
  expect(await records(page, walletAddress)).toEqual(before);
});

test('preserves originals when the backup transaction cannot commit', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress)); const before = await records(page, walletAddress);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, ...args) {
      if (value?.phase === 'prepared') throw new DOMException('Full', 'QuotaExceededError');
      return put.call(this, value, ...args);
    };
  });
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  expect(await records(page, walletAddress)).toEqual(before);
});

test('resumes an interrupted undo without deleting later data or repeating revisions', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress)); await apply(page);
  await page.evaluate(wallet => {
    const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
      if (key === `chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`) throw new DOMException('Full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  }, walletAddress);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Undo restore', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'An unfinished restore' })).toBeVisible();
  const partial = await records(page, walletAddress); expect(partial.journal.phase).toBe('undoing');
  await page.reload(); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Resume unfinished restore' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restore undone.' })).toBeVisible();
  const final = await records(page, walletAddress); expect(final.journal.phase).toBe('undone');
  expect(final.data.notes).toEqual([]); expect(final.data.revision).toBe(partial.data.revision); expect(final.marker).toBeNull();
});

test('can explicitly stop a conflicted pending restore while retaining current data and backup', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress));
  await page.evaluate(wallet => {
    const set = Storage.prototype.setItem; (window as any).__restoreSetItem = set;
    Storage.prototype.setItem = function(key, value) {
      if (key === `chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`) throw new DOMException('Full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  }, walletAddress);
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'An unfinished restore' })).toBeVisible();
  await page.evaluate(wallet => {
    Storage.prototype.setItem = (window as any).__restoreSetItem;
    localStorage.setItem(`chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`, JSON.stringify({ readReceiptsDefault: false, readReceiptOverrides: {}, blocked: [], syncAcrossDevices: false, updatedAt: 999 }));
  }, walletAddress);
  const before = await records(page, walletAddress);
  await page.getByRole('button', { name: 'Resume unfinished restore' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Keep current data and stop restore' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'import is not marked complete' })).toBeVisible();
  const after = await records(page, walletAddress);
  expect(after.data).toEqual(before.data); expect(after.prefs).toBe(before.prefs);
  expect(after.journal.before).toEqual(before.journal.before); expect(after.journal.phase).toBe('abandoned'); expect(after.marker).toBeNull();
});
