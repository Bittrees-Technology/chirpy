import { send } from './fixtures/inboundBridge';
import { writeFileSync } from 'node:fs';
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
    // Inspect only this disposable dev client. Never enable logging in the
    // shipped app or capture wallet signatures, SDK keys or message payloads.
    await context.addInitScript(() => {
      const events: unknown[] = (window as any).__bridgeDiagnostics = [];
      const OriginalWorker = Worker;
      (window as any).Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener('message', event => {
            const { action, result, error } = event.data ?? {};
            if (action === 'client.init') events.push({ action, env: result?.env, inboxId: result?.inboxId, installationId: result?.installationId, libxmtpVersion: result?.libxmtpVersion });
            else if (action === 'conversations.list') events.push({ action, ids: Array.isArray(result) ? result.map(value => value.id) : [] });
            else if (error && ['conversations.sync', 'conversations.syncAll'].includes(action)) events.push({ action, error: String(error).slice(0, 1000) });
            if (events.length > 80) events.shift();
          });
        }
        postMessage(...args: any[]) {
          const request = args[0];
          if (request?.action === 'client.init') {
            if (request.data?.options?.env !== 'dev') throw Error('Disposable diagnostic requires dev');
            request.data.options.loggingLevel = 2; // Pinned WASM LogLevel.Warn.
          }
          return (OriginalWorker.prototype.postMessage as any).apply(this, args);
        }
      };
    });
    const page = await context.newPage();
    const importErrors: string[] = [];
    page.on('console', message => {
      const text = message.text();
      if (/failed.*welcome|welcome.*fail|sync_welcomes/i.test(text)) {
        importErrors.push(text.slice(0, 2000));
        if (importErrors.length > 30) importErrors.shift();
      }
    });
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
      writeFileSync(test.info().outputPath('disposable-bridge-publication.json'), JSON.stringify(published));
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
    } finally {
      const diagnostics = await page.evaluate(() => (window as any).__bridgeDiagnostics).catch(() => []);
      const ui = await page.locator('body').innerText().catch(() => 'Unavailable');
      writeFileSync(test.info().outputPath('disposable-browser-diagnostics.json'), JSON.stringify({ diagnostics, importErrors, ui }));
      console.info('Disposable welcome errors:', JSON.stringify(importErrors));
      await context.close();
    }
  });
});
