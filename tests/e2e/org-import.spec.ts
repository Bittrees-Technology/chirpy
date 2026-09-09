import { expect, test } from '@playwright/test';

test('rejects malformed imports without replacing the active organization and recovers with a legacy config', async ({ page }) => {
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import organization' });
  const config = { version: 1, branding: { name: 'Recovered organization' }, namespace: 'recovery-test', chain: { chainId: 1 }, entryGate: [], gating: {} };
  await dialog.getByRole('textbox').fill(JSON.stringify({ ...config, roles: {} }));
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByText('Invalid org config: roles is invalid')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('chat:orgs:v2') ?? '{"orgs":[]}').orgs)).toEqual([]);
  await dialog.getByRole('textbox').fill(JSON.stringify(config));
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Active organization' })).toBeVisible();
  await expect(page.locator('.org-detail')).toContainText('Recovered organization');
  expect(pageErrors).toEqual([]);
});
