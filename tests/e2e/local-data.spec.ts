import { test, expect, injectSyntheticWallet } from './fixtures/wallet';
import type { Page } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import { decryptRecoveryArchive } from '../../apps/web/src/recoveryArchive';
const peer = '0x2222222222222222222222222222222222222222';
async function connect(page: Page) {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  const button = page.getByRole('button', { name: 'Connect wallet', exact: true });
  if (await button.isVisible()) await button.click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  await page.locator('.nav-item', { hasText: 'Chats' }).click();
}
async function open(page: Page, name: 'Contacts' | 'Local notes') {
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: name === 'Contacts' ? 'Save contact' : 'Save note', exact: true }).waitFor();
}
async function contact(page: Page, address: string, label: string) {
  await page.getByLabel('Wallet address', { exact: true }).fill(address);
  await page.getByLabel('Private contact label').fill(label);
  await page.getByRole('button', { name: 'Save contact', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved in this browser.' })).toBeVisible();
}
async function close(page: Page) { await page.getByRole('button', { name: 'Close', exact: true }).click(); }
async function snapshot(page: Page, wallet: string) {
  return page.evaluate(wallet => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('chat-local-data-v1', 1);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('wallets'); const read = tx.objectStore('wallets').get(wallet.toLowerCase());
      read.onsuccess = () => { resolve(read.result); db.close(); }; read.onerror = () => reject(read.error);
    };
    request.onerror = () => reject(request.error);
  }), wallet);
}

test('persists contacts and notes, composes with private labels, and exports both encrypted', async ({ page, walletAddress }, testInfo) => {
  await connect(page); await open(page, 'Contacts');
  await contact(page, peer, 'Personal label');
  await page.getByRole('button', { name: 'Use in message' }).click();
  await expect(page.getByRole('dialog')).toContainText('New message');
  await expect(page.getByLabel('Display name (optional)', { exact: true })).toHaveValue('Personal label');
  await expect(page.getByRole('dialog').locator('input').first()).toHaveValue(peer);
  await close(page); await open(page, 'Local notes');
  await page.getByLabel('Note text').fill('<script>local only</script>\nKeep this note.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.locator('.local-note-text')).toHaveText('<script>local only</script>\nKeep this note.');
  await page.reload();
  await open(page, 'Local notes');
  await expect(page.locator('.local-note-text')).toContainText('Keep this note.');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('local-notes-mobile.png') });
  await close(page); await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  const password = 'local data export password';
  await page.getByLabel('Recovery passphrase', { exact: true }).fill(password);
  await page.getByLabel('Confirm recovery passphrase', { exact: true }).fill(password);
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export encrypted local data', exact: true }).click();
  const download = await waiting; const stream = await download.createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  expect(raw).not.toContain('Keep this note');
  const recovered = await decryptRecoveryArchive(raw, password, walletAddress);
  expect(recovered.contacts).toEqual([{ address: peer, label: 'Personal label' }]);
  expect(recovered.notes[0].text).toContain('Keep this note.');
});

test('keeps concurrent tab additions and rejects a stale edit', async ({ browser }) => {
  const context = await browser.newContext();
  await injectSyntheticWallet(context, generatePrivateKey());
  const one = await context.newPage(); const two = await context.newPage();
  try {
    await connect(one); await connect(two);
    await open(one, 'Contacts'); await open(two, 'Contacts');
    await Promise.all([contact(one, peer, 'First'), contact(two, '0x3333333333333333333333333333333333333333', 'Second')]);
    await expect(one.locator('.local-items li')).toHaveCount(2); await expect(two.locator('.local-items li')).toHaveCount(2);
    const row = (page: Page) => page.locator('.local-items li').filter({ hasText: peer });
    await row(one).getByRole('button', { name: 'Edit', exact: true }).click();
    await row(two).getByRole('button', { name: 'Edit', exact: true }).click();
    await one.getByLabel('Private contact label').fill('Updated first');
    await one.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(row(two)).toContainText('Updated first');
    await two.getByLabel('Private contact label').fill('Stale edit');
    await two.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(two.getByRole('alert')).toContainText('changed in another session');
    await expect(two.getByLabel('Private contact label')).toHaveValue('Stale edit');
    await expect(row(two)).toContainText('Updated first');
  } finally { await context.close(); }
});

test('preserves records and input on quota failures and transaction aborts', async ({ page, walletAddress }) => {
  await connect(page); await open(page, 'Contacts'); await contact(page, peer, 'Original');
  const before = await snapshot(page, walletAddress);
  await page.locator('.local-items').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Private contact label').fill('Unsaved change');
  for (const mode of ['quota', 'abort']) {
    await page.evaluate(mode => {
      const prototype = IDBObjectStore.prototype;
      const original = (window as any).__originalPut ?? prototype.put; (window as any).__originalPut = original;
      prototype.put = function(...args: Parameters<typeof prototype.put>) {
        if (mode === 'quota') throw new DOMException('Storage full', 'QuotaExceededError');
        const request = original.apply(this, args); this.transaction.abort(); return request;
      };
    }, mode);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Could not save this change');
    await expect(page.getByLabel('Private contact label')).toHaveValue('Unsaved change');
    expect(await snapshot(page, walletAddress)).toEqual(before);
  }
});

test('rejects malformed stored data without resetting it', async ({ page, walletAddress }) => {
  await connect(page); await open(page, 'Contacts'); await contact(page, peer, 'Original'); await close(page);
  await page.evaluate(wallet => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('chat-local-data-v1', 1);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('wallets', 'readwrite');
      tx.objectStore('wallets').put({ version: 999, wallet: wallet.toLowerCase(), notes: 'unrecognized' });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    };
  }), walletAddress);
  await page.getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not read local data');
  await expect(page.getByRole('button', { name: 'Save contact', exact: true })).toHaveCount(0);
  expect(await snapshot(page, walletAddress)).toEqual({ version: 999, wallet: walletAddress.toLowerCase(), notes: 'unrecognized' });
});

test('disconnect and another wallet hide the previous wallet’s local data', async ({ page, walletAddress }) => {
  await connect(page); await open(page, 'Contacts'); await contact(page, peer, 'Wallet one private label'); await close(page);
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('.nav-item', { hasText: 'Chats' }).click();
  await page.getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toContainText('Wallet one private label'); await close(page);
  await page.evaluate(() => {
    const provider = (window as any).ethereum; const original = provider.request.bind(provider);
    provider.request = (args: any) => args.method === 'eth_requestAccounts' || args.method === 'eth_accounts' ? Promise.resolve(['0x4444444444444444444444444444444444444444']) : original(args);
  });
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  await page.locator('.nav-item', { hasText: 'Chats' }).click(); await open(page, 'Contacts');
  await expect(page.locator('.local-items li')).toHaveCount(0);
  expect((await snapshot(page, walletAddress)).contacts).toEqual([{ address: peer, label: 'Wallet one private label' }]);
});

test('cancels a queued save when its wallet session closes', async ({ page, walletAddress }) => {
  await connect(page); await open(page, 'Contacts'); await contact(page, peer, 'Original');
  const before = await snapshot(page, walletAddress);
  await page.evaluate(() => new Promise<void>(resolve => {
    const request = indexedDB.open('chat-local-data-v1', 1);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('wallets', 'readwrite'); const store = tx.objectStore('wallets');
      (window as any).__releaseLocalLock = false;
      const hold = () => {
        if (!(window as any).__releaseLocalLock) store.get('hold').onsuccess = hold;
      };
      tx.oncomplete = () => db.close(); hold(); resolve();
    };
  }));
  await page.getByLabel('Wallet address', { exact: true }).fill('0x5555555555555555555555555555555555555555');
  await page.getByLabel('Private contact label').fill('Must not save');
  await page.getByRole('button', { name: 'Save contact', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await close(page);
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.evaluate(() => { (window as any).__releaseLocalLock = true; });
  expect(await snapshot(page, walletAddress)).toEqual(before);
});

test('edits and deletes notes durably and preserves a cancelled deletion', async ({ page, walletAddress }) => {
  await connect(page); await open(page, 'Local notes');
  await page.getByLabel('Note text').fill('Original note');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.locator('.local-note-text')).toHaveText('Original note');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Note text').fill('Edited note');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.local-note-text')).toHaveText('Edited note');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await snapshot(page, walletAddress)).notes[0].text).toBe('Edited note');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.local-note-text')).toHaveCount(0);
  expect((await snapshot(page, walletAddress)).notes).toEqual([]);
});
