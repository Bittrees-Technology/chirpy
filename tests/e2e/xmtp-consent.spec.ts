import type { Page } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import { expect, injectSyntheticWallet, test } from './fixtures/wallet';

test.describe('XMTP consent ordering @xmtp', () => {
  test.use({ actionTimeout: 30_000 });
  test.describe.configure({ timeout: 360_000, retries: 0 });

  test('keeps explicit block choices across replay and creator installation recovery', async ({ browser }) => {
    test.skip(process.env.XMTP_E2E !== '1', 'Only disposable XMTP-dev wallets.');
    const creator = await browser.newContext();
    const recipient = await browser.newContext();
    const recovered = await browser.newContext();
    const creatorKey = generatePrivateKey();
    const address = await injectSyntheticWallet(creator, creatorKey);
    const peer = await injectSyntheticWallet(recipient, generatePrivateKey());
    await injectSyntheticWallet(recovered, creatorKey);
    for (const context of [creator, recipient, recovered]) await context.addInitScript(() => {
      const trace = (window as any).__consentTrace = [];
      const startedAt = Date.now();
      const pending = new Map<string, any>();
      const previous = new Map<string, string>();
      const OriginalWorker = Worker;
      const add = (entry: any) => { trace.push({ ms: Date.now() - startedAt, ...entry }); if (trace.length > 200) trace.shift(); };
      (window as any).Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          (window as any).__consentWorker = this;
          this.addEventListener('message', event => {
            const { id, action, result, error } = event.data ?? {};
            const request = pending.get(id); pending.delete(id);
            if (action === 'conversation.consentState') {
              const key = request?.conversation;
              if (previous.get(key) !== String(result)) { previous.set(key, String(result)); add({ action, conversation: key, state: result }); }
            } else if (action === 'dm.peerInboxId') {
              add({ ...request, peer: result });
            } else if (action === 'preferences.getInboxStates' || action === 'preferences.fetchInboxStates') {
              add({ ...request, error: error ? String(error).slice(0, 300) : undefined, states: Array.isArray(result) ? result.map(s => ({ inboxId: s.inboxId, accountIdentifiers: s.accountIdentifiers })) : [] });
            } else if (action === 'conversations.list') {
              const ids = Array.isArray(result) ? result.map(r => r.id) : [];
              const key = ids.join(',');
              if (previous.get('list') !== key) { previous.set('list', key); add({ action, ids }); }
            } else if (request) add({ ...request, error: error ? String(error).slice(0, 300) : undefined });
          });
        }
        postMessage(...args: any[]) {
          const message = args[0];
          if (['conversations.sync', 'conversations.syncAll', 'preferences.sync', 'conversation.consentState', 'conversation.updateConsentState', 'client.sendSyncRequest', 'conversations.list', 'dm.peerInboxId', 'preferences.getInboxStates', 'preferences.fetchInboxStates'].includes(message?.action)) {
            if (['conversations.sync', 'conversations.syncAll', 'client.sendSyncRequest'].includes(message.action)) add({ action: message.action, phase: 'requested' });
            pending.set(message.id, { action: message.action, conversation: message.data?.id, state: message.data?.state, inboxIds: message.data?.inboxIds });
            if (pending.size > 100) pending.delete(pending.keys().next().value!);
          }
          return (OriginalWorker.prototype.postMessage as any).apply(this, args);
        }
      };
    });
    const first = await creator.newPage();
    const second = await recipient.newPage();
    const fresh = await recovered.newPage();
    try {
      await enable(first, address); await enable(second, peer);
      await first.getByRole('button', { name: '+ Chat', exact: true }).click();
      await first.getByLabel('Recipient').fill(peer);
      await first.getByRole('button', { name: 'Start chat', exact: true }).click();
      await first.locator('.composer-input').fill('consent ordering synthetic message');
      await first.getByRole('button', { name: 'Send', exact: true }).click();
      await second.getByRole('button', { name: 'Requests', exact: true }).click();
      await second.locator('.list-item', { hasText: 'consent ordering synthetic message' }).click({ timeout: 120_000 });
      await second.getByRole('button', { name: 'Accept request', exact: true }).click();
      await second.locator('.composer-input').fill('consent ordering synthetic reply');
      await second.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(first.locator('.msg-body', { hasText: 'consent ordering synthetic reply' })).toBeVisible({ timeout: 120_000 });
      await first.bringToFront();
      await first.getByRole('button', { name: 'Block conversation', exact: true }).click();
      await expect(first.locator('.msg-body')).toHaveCount(0);
      await first.getByRole('button', { name: 'Blocked', exact: true }).click();
      await expect(first.locator('.list-item:not(.saved-row)')).toHaveCount(1);
      await first.getByRole('button', { name: 'Unblock conversation', exact: true }).click();
      await first.getByRole('button', { name: 'Inbox', exact: true }).click();
      await expect(first.locator('.msg-body', { hasText: 'consent ordering synthetic reply' })).toBeVisible();
      await first.getByRole('button', { name: 'Block conversation', exact: true }).click();
      await expect(first.locator('.composer-input')).toHaveCount(0);
      console.info('Consent acceptance: creator block/unblock/reblock passed.');

      // Model the old installation remaining open in a background tab. This is
      // explicit because headless contexts do not reliably change visibility.
      await first.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));

      // Recovery may supply a default for a creator's conversations. That default
      // must not outrank this explicit block, irrespective of archive/welcome order.
      await enable(fresh, address);
      console.info('Consent acceptance: fresh installation enabled.');
      // An existing member's send supplies a welcome to the new installation,
      // exercising the creator default even though the creator had blocked it.
      await second.bringToFront();
      await second.locator('.composer-input').fill('consent creator recovery trigger');
      await second.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(second.locator('.msg-body', { hasText: 'consent creator recovery trigger' })).toBeVisible();
      await fresh.bringToFront();
      console.info('Consent acceptance: welcome trigger sent.');
      await fresh.locator('.nav-item', { hasText: 'Settings' }).click();
      await fresh.getByRole('button', { name: 'Request message history', exact: true }).click();
      await expect(fresh.getByRole('status').filter({ hasText: 'History requested.' })).toBeVisible();
      console.info('Consent acceptance: archive requested.');
      await fresh.locator('.nav-item', { hasText: 'Chats' }).click();
      await fresh.getByRole('button', { name: 'Blocked', exact: true }).click();
      await expect(fresh.locator('.list-item:not(.saved-row)')).toHaveCount(1, { timeout: 120_000 });
      await fresh.locator('.list-item:not(.saved-row)').click();
      await expect(fresh.getByRole('button', { name: 'Unblock conversation', exact: true })).toBeVisible();
      await expect(fresh.locator('.msg-body')).toHaveCount(0);
      await expect(fresh.locator('.composer-input')).toHaveCount(0);
      console.info('Consent acceptance: creator block recovered on a fresh installation.');

      // Exercise consent only: restoring history does not establish active MLS
      // membership on this installation. Active-room recovery is tested separately.
      await fresh.getByRole('button', { name: 'Unblock conversation', exact: true }).click();
      await fresh.getByRole('button', { name: 'Inbox', exact: true }).click();
      await expect(fresh.locator('.list-item', { hasText: 'consent creator recovery trigger' })).toBeVisible({ timeout: 120_000 });
      await expect(fresh.getByRole('button', { name: 'Block conversation', exact: true })).toBeVisible();
      await first.bringToFront();
      await first.evaluate(() => { delete (document as any).visibilityState; });
      await first.getByRole('button', { name: 'Inbox', exact: true }).click();
      await expect(first.locator('.list-item', { hasText: 'consent creator recovery trigger' })).toBeVisible({ timeout: 120_000 });
      await first.getByRole('button', { name: 'Block conversation', exact: true }).click();
      await fresh.bringToFront();
      await fresh.getByRole('button', { name: 'Blocked', exact: true }).click();
      await expect(fresh.locator('.list-item:not(.saved-row)')).toHaveCount(1, { timeout: 120_000 });
      await expect(fresh.locator('.msg-body')).toHaveCount(0);
      await expect(fresh.locator('.composer-input')).toHaveCount(0);
      console.info('Consent acceptance: newer choices synchronized in both directions.');
    } catch (error) {
      for (const [name, page] of [['original', first], ['fresh', fresh]] as const) {
        console.info(name, 'archive evidence', await archiveEvidence(page));
        console.info(name, 'consent trace', JSON.stringify(await page.evaluate(() => (window as any).__consentTrace).catch(() => [])));
        console.info(name, 'synthetic UI', (await page.locator('body').innerText().catch(() => '')).slice(0, 4000));
      }
      throw error;
    } finally {
      await Promise.all([recovered.close(), recipient.close(), creator.close()]);
    }
  });
});

async function enable(page: Page, address: string) {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(address);
  await page.getByRole('button', { name: 'Enable messaging', exact: true }).click();
  await expect(page.getByText('Messaging enabled on this device.')).toBeVisible({ timeout: 120_000 });
  await page.locator('.nav-item', { hasText: 'Chats' }).click();
}

// Read-only diagnostics for disposable acceptance identities. Never print archive
// pins, URLs, encryption material, payloads, or private keys.
async function archiveEvidence(page: Page) {
  return page.evaluate(() => new Promise(resolve => {
    const worker = (window as any).__consentWorker as Worker | undefined;
    if (!worker) { resolve({ available: false }); return; }
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { worker.removeEventListener('message', receive); resolve({ timedOut: true }); }, 5_000);
    function receive(event: MessageEvent) {
      if (event.data?.id !== id) return;
      clearTimeout(timeout); worker!.removeEventListener('message', receive);
      resolve({ failed: Boolean(event.data.error), archiveCount: Array.isArray(event.data.result) ? event.data.result.length : null,
        visibility: document.visibilityState });
    }
    worker.addEventListener('message', receive);
    worker.postMessage({ id, action: 'client.listAvailableArchives', data: { daysCutoff: 1n } });
  })).catch(() => ({ unavailable: true }));
}
