import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const a = '0x000000000000000000000000000000000000000a';
const b = '0x000000000000000000000000000000000000000b';
const c = '0x000000000000000000000000000000000000000c';

test.beforeEach(async ({ page }) => {
  if (process.env.CHIRPY_TEST_NATIVE_CSP === '1') {
    const policy = JSON.parse(readFileSync('apps/web/src-tauri/tauri.conf.json', 'utf8')).app.security.csp;
    await page.route('http://127.0.0.1:*/**', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
    });
  }
  await page.route(/^https:\/\//, route => route.abort());
  await page.addInitScript(({ a, b }) => {
    const providers = [a, b].map(address => {
      const listeners = new Map<string, Set<Function>>();
      return {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
          if (method === 'eth_chainId') return '0x1';
          throw Error('Synthetic selection test does not sign or send.');
        },
        on(event: string, listener: Function) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
        removeListener(event: string, listener: Function) { listeners.get(event)?.delete(listener); },
        emit(event: string, value: unknown) { listeners.get(event)?.forEach(listener => listener(value)); },
      };
    });
    (window as any).ethereum = providers[0];
    (window as any).__selectionWallets = providers;
    const announce = (index: number) => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider: providers[index], info: {
        uuid: crypto.randomUUID(), name: index ? 'Second wallet' : 'First wallet',
        rdns: index ? 'org.second.wallet' : 'org.first.wallet', icon: 'data:image/svg+xml,<svg onload="alert(1)"/>',
      } },
    }));
    window.addEventListener('eip6963:requestProvider', () => {
      announce(0);
      if (!sessionStorage.getItem('hideSecondWallet')) announce(1);
    });
    (window as any).__announceSecond = () => announce(1);
  }, { a, b });
});

test('selects a wallet, isolates events, restores the same provider, and stays disconnected after disconnect', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  const connect = page.getByRole('button', { name: 'Connect wallet', exact: true });
  const address = page.getByRole('textbox', { name: 'Address', exact: true });
  await expect(connect).toBeDisabled();
  await page.getByRole('combobox', { name: 'Browser wallet', exact: true }).selectOption({ label: 'Second wallet (org.second.wallet)' });
  await page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Account', exact: true }) }).screenshot({ path: testInfo.outputPath('wallet-selection.png') });
  await connect.click();
  await expect(address).toHaveValue(b);
  await page.evaluate(a => (window as any).__selectionWallets[0].emit('accountsChanged', [a]), a);
  await expect(address).toHaveValue(b);
  await page.evaluate(c => (window as any).__selectionWallets[1].emit('accountsChanged', [c]), c);
  await expect(address).toHaveValue(c);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.evaluate(b => (window as any).__selectionWallets[1].emit('accountsChanged', [b]), b);
  await expect(connect).toBeVisible();
  await page.getByRole('combobox', { name: 'Browser wallet', exact: true }).selectOption({ label: 'Second wallet (org.second.wallet)' });
  await connect.click();
  await expect(address).toHaveValue(b);
  await page.reload();
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await expect(address).toHaveValue(b);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.reload();
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await expect(connect).toBeVisible();
  await expect(address).not.toHaveValue(b);
});

test('does not substitute the default wallet when the selected extension is absent; discovers it later', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('combobox', { name: 'Browser wallet', exact: true }).selectOption({ label: 'Second wallet (org.second.wallet)' });
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(b);
  await page.evaluate(() => sessionStorage.setItem('hideSecondWallet', 'true'));
  await page.reload();
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).not.toHaveValue(a);
  await page.evaluate(() => (window as any).__announceSecond());
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(b);
});
