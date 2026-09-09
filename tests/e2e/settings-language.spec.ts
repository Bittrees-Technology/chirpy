import { expect, test } from './fixtures/wallet';

test('Spanish settings retain language, explain privacy controls and localize sync results', async ({ page, walletAddress }, testInfo) => {
  expect(walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  let revision = 0;
  await page.route('**/api/usersync**', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { blob: null, revision, epoch: 0, authVersion: 2, service: new URL('/api/usersync', route.request().url()).href } });
    return route.fulfill({ json: { ok: true, revision: ++revision } });
  });
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('heading', { name: 'Ajustes', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Actualización de software' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Confirmaciones de lectura por defecto' })).toBeVisible();
  await expect(page.getByText('Las confirmaciones ya enviadas no se pueden retirar.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('La sincronización cifrada está activada durante esta sesión del navegador');
  await page.getByRole('button', { name: 'Desactivar', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('se ha revocado la autorización de este dispositivo');
  await page.getByPlaceholder('nombre.eth o dirección 0x').fill('invalid');
  await expect(page.getByText('Introduce un nombre .eth o una dirección 0x.', { exact: true })).toBeVisible();
  await page.reload();
  await page.locator('.nav-item', { hasText: 'Ajustes' }).click();
  await expect(page.getByRole('combobox', { name: 'Idioma', exact: true })).toHaveValue('es');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Revocar todos los dispositivos sincronizados' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('settings-spanish-mobile.png'), fullPage: true });
  await page.getByRole('combobox', { name: 'Idioma', exact: true }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
