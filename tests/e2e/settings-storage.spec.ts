import { test, expect } from './fixtures/wallet';
import type { Page } from '@playwright/test';
async function connect(page: Page) {
  await page.goto('/'); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
}
test('failed preference writes preserve stored data and visibly pause export', async ({ page, walletAddress }, testInfo) => {
  await connect(page);
  const key = `chat:settingsPrefs:v1:wallet:${walletAddress.toLowerCase()}`;
  const toggle = page.getByRole('switch', { name: 'Read receipts default' });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const before = await page.evaluate(key => localStorage.getItem(key), key);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('chat:settingsPrefs:v1:')) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await toggle.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Settings could not be saved' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(before);
  await expect(page.getByRole('button', { name: 'Export encrypted local data' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await page.locator('.settings').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('settings-storage-mobile.png') });
});
test('does not replace malformed settings with defaults on mount or edit', async ({ page, walletAddress }) => {
  const key = `chat:settingsPrefs:v1:wallet:${walletAddress.toLowerCase()}`;
  await page.addInitScript(({ key }) => localStorage.setItem(key, '{original broken record'), { key });
  await connect(page);
  await expect(page.getByRole('alert').filter({ hasText: 'Settings could not be saved' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Read receipts default' })).toBeDisabled();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('{original broken record');
  await expect(page.getByRole('switch', { name: 'Read receipts default' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('button', { name: 'Export encrypted local data' })).toHaveCount(0);
});
test('detects another tab’s stored settings before applying a stale edit', async ({ page, walletAddress }) => {
  await connect(page);
  const key = `chat:settingsPrefs:v1:wallet:${walletAddress.toLowerCase()}`;
  const raw = JSON.stringify({ readReceiptsDefault: false, syncAcrossDevices: false, blocked: [], readReceiptOverrides: {}, updatedAt: 123 });
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
  await page.getByRole('switch', { name: 'Read receipts default' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Settings could not be saved' })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(raw);
});
