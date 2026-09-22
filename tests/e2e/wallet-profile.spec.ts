import { expect, test } from './fixtures/wallet';

test('wallet display choice wins over ENS, survives reload, and remains explicitly local', async ({ page, walletAddress }) => {
  expect(walletAddress).toMatch(/^0x/);
  await page.route(/^https:\/\/(?!api\.ensideas\.com\/)/, route => route.abort());
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Display name', exact: true });
  await expect(name).toHaveValue('test.eth');
  await name.fill('My chosen name');
  await expect(page.locator('.profile-name')).toHaveText('My chosen name');
  await expect(page.getByText('Changing it does not publish a public profile', { exact: false })).toBeVisible();
  await page.reload();
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await expect(name).toHaveValue('My chosen name');
  await expect(page.locator('.profile-name')).toHaveText('My chosen name');
  await name.fill('');
  await expect(page.locator('.profile-name')).not.toHaveText('test.eth');
  await expect(page.locator('.foot-name')).toContainText('0x');
  await page.reload();
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await expect(name).toHaveValue('');
  await expect(page.locator('.profile-name')).not.toHaveText('test.eth');
  await expect(page.locator('.foot-name')).toContainText('0x');
  await page.getByRole('button', { name: 'Use ENS name', exact: true }).click();
  await expect(name).toHaveValue('test.eth');
  await expect(page.locator('.profile-name')).toHaveText('test.eth');
});
