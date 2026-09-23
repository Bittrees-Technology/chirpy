import { test, expect } from './fixtures/wallet';
import { decryptRecoveryArchive } from '../../apps/web/src/recoveryArchive';

const password = 'unique settings backup passphrase';
async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('heading', { name: 'Back up local data' }).waitFor();
  await page.getByLabel('Recovery passphrase', { exact: true }).fill(password);
  await page.getByLabel('Confirm recovery passphrase', { exact: true }).fill(password);
}

test('downloads a wallet-verified encrypted settings file without changing storage', async ({ page, walletAddress }, testInfo) => {
  await openSettings(page);
  await page.getByLabel('Display name', { exact: true }).fill('Private backup name');
  await expect.poll(() => page.evaluate(wallet => localStorage.getItem(`chat:walletProfile:v1:${wallet.toLowerCase()}`), walletAddress)).toBe('"Private backup name"');
  await page.getByRole('switch', { name: 'Read receipts default' }).click();
  await expect(page.getByRole('switch', { name: 'Read receipts default' })).toHaveAttribute('aria-checked', 'true');
  const before = await page.evaluate(() => ({ ...localStorage }));
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export encrypted local data', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('chat-local-data-recovery.json');
  const stream = await download.createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  expect(raw).not.toContain(walletAddress.toLowerCase());
  const data = await decryptRecoveryArchive(raw, password, walletAddress);
  expect(data.wallet).toBe(walletAddress.toLowerCase());
  expect(data).toMatchObject({ version: 2, localDisplayName: 'Private backup name' });
  expect(raw).not.toContain('Private backup name');
  expect(data.preferences.readReceiptsDefault).toBe(true);
  expect(data.contacts).toEqual([]); expect(data.notes).toEqual([]);
  expect(data.preferences).not.toHaveProperty('syncAcrossDevices');
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(before);
  await expect(page.getByLabel('Recovery passphrase', { exact: true })).toHaveValue('');
  await expect(page.getByRole('status').filter({ hasText: 'Encrypted file prepared' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('region', { name: 'Back up local data' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('settings-recovery-mobile.png') });
});

test('does not download after a rejected ownership signature', async ({ page, walletAddress }) => {
  expect(walletAddress).toMatch(/^0x/);
  await openSettings(page);
  let downloads = 0; page.on('download', () => downloads++);
  await page.evaluate(() => {
    const provider = (window as any).ethereum; const request = provider.request.bind(provider);
    provider.request = (args: any) => args.method === 'personal_sign' ? Promise.reject(new Error('User rejected')) : request(args);
  });
  await page.getByRole('button', { name: 'Export encrypted local data', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No recovery file was prepared' })).toBeVisible();
  expect(downloads).toBe(0);
});

test('cancels export if the wallet disconnects while its signature is pending', async ({ page, walletAddress }) => {
  expect(walletAddress).toMatch(/^0x/); await openSettings(page);
  let downloads = 0; page.on('download', () => downloads++);
  await page.evaluate(() => {
    const provider = (window as any).ethereum; const request = provider.request.bind(provider);
    provider.request = (args: any) => args.method === 'personal_sign'
      ? new Promise(resolve => { (window as any).__finishRecoverySignature = async () => resolve(await request(args)); }) : request(args);
  });
  await page.getByRole('button', { name: 'Export encrypted local data', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).__finishRecoverySignature));
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.evaluate(async () => { await (window as any).__finishRecoverySignature(); });
  await expect(page.getByRole('heading', { name: 'Back up local data' })).toHaveCount(0);
  expect(downloads).toBe(0);
});

test('cancels export if settings change during encryption', async ({ page, walletAddress }) => {
  expect(walletAddress).toMatch(/^0x/); await openSettings(page);
  let downloads = 0; page.on('download', () => downloads++);
  await page.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = async (...args: Parameters<typeof encrypt>) => {
      const result = await encrypt(...args);
      return new Promise(resolve => { (window as any).__finishRecoveryEncryption = () => resolve(result); });
    };
  });
  await page.getByRole('button', { name: 'Export encrypted local data', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).__finishRecoveryEncryption));
  await page.getByRole('switch', { name: 'Read receipts default' }).click();
  await page.evaluate(() => { (window as any).__finishRecoveryEncryption(); });
  await expect(page.getByRole('alert').filter({ hasText: 'No recovery file was prepared' })).toBeVisible();
  expect(downloads).toBe(0);
});

test('cancels export if local data changes during encryption', async ({ page, walletAddress }) => {
  await openSettings(page);
  let downloads = 0; page.on('download', () => downloads++);
  await page.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = async (...args: Parameters<typeof encrypt>) => {
      const result = await encrypt(...args);
      return new Promise(resolve => { (window as any).__finishRecoveryEncryption = () => resolve(result); });
    };
  });
  await page.getByRole('button', { name: 'Export encrypted local data', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).__finishRecoveryEncryption));
  await page.evaluate(wallet => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('chat-local-data-v1', 1);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('wallets', 'readwrite');
      tx.objectStore('wallets').put({ version: 1, wallet: wallet.toLowerCase(), revision: 1, contacts: [], notes: [{ id: 'new', text: 'Another tab', sentAtMs: 1 }] });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    };
  }), walletAddress);
  await page.evaluate(() => { (window as any).__finishRecoveryEncryption(); });
  await expect(page.getByRole('alert').filter({ hasText: 'No recovery file was prepared' })).toBeVisible();
  expect(downloads).toBe(0);
});

test('cancels export when the private name changes while encryption is pending', async ({ page, walletAddress }) => {
  await openSettings(page);
  let downloads = 0; page.on('download', () => downloads++);
  await page.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = async (...args: Parameters<typeof encrypt>) => {
      const result = await encrypt(...args);
      return new Promise(resolve => { (window as any).__finishNameEncryption = () => resolve(result); });
    };
  });
  await page.getByRole('button', { name: 'Export encrypted local data', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).__finishNameEncryption));
  await page.getByLabel('Display name', { exact: true }).fill('Later private name');
  await expect.poll(() => page.evaluate(wallet => localStorage.getItem(`chat:walletProfile:v1:${wallet.toLowerCase()}`), walletAddress)).toBe('"Later private name"');
  await page.evaluate(() => { (window as any).__finishNameEncryption(); });
  await expect(page.getByRole('alert').filter({ hasText: 'No recovery file was prepared' })).toBeVisible();
  expect(downloads).toBe(0);
});
