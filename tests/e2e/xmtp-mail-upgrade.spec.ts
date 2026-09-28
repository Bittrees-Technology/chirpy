import { readFileSync, writeFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, injectSyntheticWallet, test } from './fixtures/wallet';
import { send } from './fixtures/inboundBridge';

test.describe('Existing browser bridge compatibility @xmtp', () => {
  test.describe.configure({ timeout: 420_000, retries: 0 });
  test('preserves the installed identity and old history while receiving a native bridge message', async ({ browser }) => {
    const previous = process.env.CHAT_TEST_PREVIOUS_URL;
    const runtime = process.env.CHAT_TEST_BRIDGE_RUNTIME;
    test.skip(!previous || !runtime, 'Requires the isolated previous-build runner.');
    expect(process.env.XMTP_E2E).toBe('1');
    expect(process.env.VITE_XMTP_ENV).toBe('dev');
    expect(new URL(previous!).origin).toBe('http://127.0.0.1:1421');
    const receiver = await browser.newContext();
    const peer = await browser.newContext();
    const wallet = await injectSyntheticWallet(receiver);
    const peerWallet = await injectSyntheticWallet(peer);
    let upgraded = false;
    const policy = JSON.parse(readFileSync('apps/web/src-tauri/tauri.conf.json', 'utf8')).app.security.csp;
    for (const context of [receiver, peer]) {
      await captureIdentity(context);
      await context.route('http://127.0.0.1:1420/**', async route => {
        if (context === receiver && upgraded) return route.fallback();
        const source = new URL(route.request().url());
        const response = await route.fetch({ url: previous + source.pathname + source.search });
        await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
      });
    }
    const first = await receiver.newPage();
    const second = await peer.newPage();
    try {
      await enable(first, wallet); await enable(second, peerWallet);
      const before = await identity(first);
      writeFileSync(test.info().outputPath('upgrade-before.json'), JSON.stringify(before));
      await second.getByRole('button', { name: '+ Chat', exact: true }).click();
      await second.getByLabel('Recipient').fill(wallet);
      await second.getByRole('button', { name: 'Start chat', exact: true }).click();
      await second.locator('.composer-input').fill('Existing browser history before bridge repair');
      await second.getByRole('button', { name: 'Send', exact: true }).click();
      await first.getByRole('button', { name: 'Requests', exact: true }).click();
      await first.locator('.list-item', { hasText: 'Existing browser history before bridge repair' }).click({ timeout: 120_000 });
      await first.getByRole('button', { name: 'Accept request', exact: true }).click();
      await expect(first.locator('.msg-body', { hasText: 'Existing browser history before bridge repair' })).toBeVisible();
      upgraded = true;
      await first.reload();
      const after = await identity(first);
      writeFileSync(test.info().outputPath('upgrade-after.json'), JSON.stringify(after));
      expect(after.inboxId).toBe(before.inboxId);
      expect(after.installationId).toBe(before.installationId);
      await first.locator('.nav-item', { hasText: 'Chats' }).click();
      await first.getByRole('button', { name: 'Inbox', exact: true }).click();
      await first.locator('.list-item', { hasText: 'Existing browser history before bridge repair' }).click({ timeout: 120_000 });
      await expect(first.locator('.msg-body', { hasText: 'Existing browser history before bridge repair' })).toBeVisible();
      expect(after.env).toBe('dev');
      expect(before.libxmtpVersion).toBe('1.9.0');
      expect(after.libxmtpVersion).toBe('1.10.0');
      await first.locator('.composer-input').fill('Existing installation reply after bridge repair');
      await first.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(second.locator('.msg-body', { hasText: 'Existing installation reply after bridge repair' })).toBeVisible({ timeout: 120_000 });
      const published = await send(runtime!, wallet.toLowerCase());
      writeFileSync(test.info().outputPath('upgrade-publication.json'), JSON.stringify({ before, after, published }));
      await first.getByRole('button', { name: 'Requests', exact: true }).click();
      await first.locator('.list-item', { hasText: 'Bridge browser acceptance' }).click({ timeout: 120_000 });
      await expect(first.locator('.msg-body').filter({ hasText: published.eventId })).toHaveText(published.text);
      console.info('Same dev installation retained its earlier history and received the actual native bridge publication after upgrade.');
    } finally {
      const ui = await first.locator('body').innerText().catch(() => 'Unavailable');
      await first.locator('.nav-item', { hasText: 'Settings' }).click().catch(() => {});
      writeFileSync(test.info().outputPath('upgrade-browser-state.json'), JSON.stringify({ identity: await identity(first).catch(() => null), ui, settings: await first.locator('body').innerText().catch(() => 'Unavailable'), errors: await first.evaluate(() => (window as any).__upgradeErrors).catch(() => []) }));
      await receiver.close(); await peer.close();
    }
  });
});

async function captureIdentity(context: BrowserContext) {
  await context.addInitScript(() => {
    const errors: unknown[] = (window as any).__upgradeErrors = [];
    const OriginalWorker = Worker;
    (window as any).Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', event => {
          const { action, error } = event.data ?? {};
          if (error && ['client.init', 'client.register', 'conversations.list', 'conversations.sync', 'conversations.syncAll'].includes(action)) {
            errors.push({ action, message: String(error?.message ?? error).replace(/[a-f0-9]{64,}/gi, '[redacted]').slice(0, 1000) });
            if (errors.length > 20) errors.shift();
          }
          if (event.data?.action !== 'client.init' || !event.data?.result) return;
          const { inboxId, installationId, libxmtpVersion, env } = event.data.result;
          (window as any).__upgradeIdentity = { inboxId, installationId, libxmtpVersion, env };
        });
      }
    };
  });
}
async function identity(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__upgradeIdentity))).toBe(true);
  return page.evaluate(() => (window as any).__upgradeIdentity as { inboxId: string; installationId: string; libxmtpVersion: string; env: string });
}
async function enable(page: Page, wallet: string) {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(wallet);
  await page.getByRole('button', { name: 'Enable messaging', exact: true }).click();
  await expect(page.getByText('Messaging enabled on this device.')).toBeVisible({ timeout: 120_000 });
  await page.locator('.nav-item', { hasText: 'Chats' }).click();
}
