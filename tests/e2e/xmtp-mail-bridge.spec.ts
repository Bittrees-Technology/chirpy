import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect, injectSyntheticWallet, test } from './fixtures/wallet';

test.describe('Mail bridge to browser @xmtp', () => {
  test.describe.configure({ timeout: 360_000, retries: 0 });
  test('displays the actual Node bridge publication and preserves it on reload', async ({ browser }) => {
    const runtime = process.env.CHAT_TEST_BRIDGE_RUNTIME;
    test.skip(!runtime, 'Run scripts/test-mail-browser-bridge.mjs --dev on Linux Node 24.');
    expect(process.env.XMTP_E2E).toBe('1');
    expect(process.env.VITE_XMTP_ENV).toBe('dev');
    expect(process.env.VITE_TRANSPORT).toBe('xmtp');
    const context = await browser.newContext();
    const wallet = await injectSyntheticWallet(context);
    const page = await context.newPage();
    try {
      await page.goto('/');
      await page.locator('.nav-item', { hasText: 'Settings' }).click();
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(wallet);
      await page.getByRole('button', { name: 'Enable messaging', exact: true }).click();
      await expect(page.getByText('Messaging enabled on this device.')).toBeVisible({ timeout: 120_000 });
      await page.locator('.nav-item', { hasText: 'Chats' }).click();
      const published = await send(runtime!, wallet.toLowerCase());
      expect(published.network).toBe('dev');
      await test.info().attach('disposable-bridge-publication', { body: JSON.stringify(published), contentType: 'application/json' });
      await page.getByRole('button', { name: 'Requests', exact: true }).click();
      await page.locator('.list-item', { hasText: 'Bridge browser acceptance' }).click({ timeout: 120_000 });
      const message = page.locator('.msg-body').filter({ hasText: published.eventId });
      await expect(message).toHaveCount(1);
      await expect(message).toHaveText(published.text);
      await page.getByRole('button', { name: 'Accept request', exact: true }).click();
      await page.reload();
      await page.locator('.nav-item', { hasText: 'Chats' }).click();
      await page.getByRole('button', { name: 'Inbox', exact: true }).click();
      await page.locator('.list-item', { hasText: 'Bridge browser acceptance' }).click({ timeout: 120_000 });
      await expect(message).toHaveCount(1);
      await expect(message).toHaveText(published.text);
      console.info('Actual dev Node bridge publication displayed once and survived browser reload.');
    } finally { await context.close(); }
  });
});

function send(runtime: string, wallet: string): Promise<{ network: string; eventId: string; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(runtime, 'sender.mjs'), '--dev', wallet], {
      cwd: runtime, env: { PATH: '/usr/bin:/bin', HOME: runtime, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 160_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Disposable sender failed (${code}): ${errors}`));
      const line = output.split('\n').find(value => value.startsWith('BRIDGE_RECEIPT='));
      if (!line) return reject(new Error('Missing exact bridge publication receipt'));
      try { resolve(JSON.parse(line.slice('BRIDGE_RECEIPT='.length))); } catch (error) { reject(error); }
    });
  });
}
