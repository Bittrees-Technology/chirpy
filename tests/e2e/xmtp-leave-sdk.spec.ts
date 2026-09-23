import type { Page } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import { expect, injectSyntheticWallet, test } from './fixtures/wallet';

test.describe('XMTP native leave @xmtp', () => {
  test.use({ actionTimeout: 30_000 });
  test.describe.configure({ timeout: 360_000, retries: 0 });
  test('retains owner protections and distinguishes requested removal from confirmed removal', async ({ browser }) => {
    test.skip(process.env.XMTP_E2E !== '1', 'Disposable XMTP-dev identities only.');
    const owner = await browser.newContext(), member = await browser.newContext();
    const ownerWallet = await injectSyntheticWallet(owner, generatePrivateKey());
    const memberWallet = await injectSyntheticWallet(member, generatePrivateKey());
    for (const context of [owner, member]) await context.addInitScript(() => {
      const OriginalWorker = Worker;
      (window as any).Worker = class extends OriginalWorker {
        postMessage(...args: any[]) {
          if (args[0]?.action === 'conversations.list') (window as any).__leaveSdkWorker = this;
          return (OriginalWorker.prototype.postMessage as any).apply(this, args);
        }
      };
    });
    const a = await owner.newPage(), b = await member.newPage();
    try {
      await enable(a, ownerWallet); await enable(b, memberWallet);
      await a.locator('.nav-item', { hasText: 'Rooms' }).click();
      await a.getByRole('button', { name: '+ Room', exact: true }).click();
      await a.getByLabel('Room name').fill('disposable leave compatibility');
      await a.getByRole('button', { name: 'Create room', exact: true }).click();
      await expect(a.locator('.thread-title')).toContainText('disposable leave compatibility', { timeout: 120_000 });
      const groups = await sdk(a, 'conversations.listGroups', { options: {} });
      expect(groups.ok).toBe(true); expect(groups.result).toHaveLength(1);
      const id = groups.result[0].id;
      expect(await sdk(a, 'group.isPendingRemoval', { id })).toEqual({ ok: true, result: false });
      expect((await sdk(a, 'group.requestRemoval', { id })).error).toContain('only one member');
      await a.locator('.room-members summary').click();
      await a.getByLabel('Member wallet', { exact: true }).fill(memberWallet);
      await a.getByRole('button', { name: 'Add member', exact: true }).click();
      await expect(a.getByRole('status').filter({ hasText: 'Member added.' })).toBeVisible({ timeout: 120_000 });
      await a.locator('.composer-input').fill('leave compatibility invitation');
      await a.getByRole('button', { name: 'Send', exact: true }).click();
      await b.locator('.nav-item', { hasText: 'Rooms' }).click();
      await b.getByRole('button', { name: 'Requests', exact: true }).click();
      await b.locator('.list-item', { hasText: 'leave compatibility invitation' }).click({ timeout: 120_000 });
      await b.getByRole('button', { name: 'Accept request', exact: true }).click();
      expect((await sdk(a, 'group.requestRemoval', { id })).error).toContain('super-admin');
      expect(await sdk(a, 'group.isPendingRemoval', { id })).toEqual({ ok: true, result: false });
      const dm = await sdk(a, 'conversations.createDmWithIdentifier', { identifier: { identifier: memberWallet.toLowerCase(), identifierKind: 0 } });
      expect(dm.ok).toBe(true);
      expect((await sdk(a, 'group.requestRemoval', { id: dm.result.id })).error).toContain('DM conversation');
      console.info('Leave acceptance: singleton, super-admin and DM protections passed.');

      // Stop only this disposable test page. The owner's worker must be offline
      // to prove that submitting a request is not itself membership removal.
      await a.goto('about:blank');
      expect(await sdk(b, 'group.isPendingRemoval', { id })).toEqual({ ok: true, result: false });
      await b.getByRole('button', { name: 'Leave room', exact: true }).click();
      await expect(b.getByRole('dialog', { name: 'Request to leave this room?' })).toBeVisible();
      await b.keyboard.press('Escape');
      expect(await sdk(b, 'group.isPendingRemoval', { id })).toEqual({ ok: true, result: false });
      await b.getByRole('button', { name: 'Leave room', exact: true }).click();
      await b.getByRole('button', { name: 'Request removal', exact: true }).click();
      await expect(b.getByRole('region', { name: 'Room membership' })).toContainText('Removal requested.');
      await expect(b.locator('.composer-input')).toHaveCount(0);
      expect(await sdk(b, 'group.isPendingRemoval', { id })).toEqual({ ok: true, result: true });
      expect(await sdk(b, 'conversation.isActive', { id })).toEqual({ ok: true, result: true });
      expect((await sdk(b, 'group.requestRemoval', { id })).ok).toBe(true);
      expect(await sdk(b, 'group.isPendingRemoval', { id })).toEqual({ ok: true, result: true });
      console.info('Leave acceptance: offline-owner request stays pending; duplicate request is safe.');

      await enable(a, ownerWallet);
      await expect.poll(async () => {
        const synced = await sdk(a, 'conversations.syncAll', {});
        if (!synced.ok) throw Error(synced.error);
        const roster = await sdk(a, 'conversation.members', { id });
        if (!roster.ok) throw Error(roster.error);
        return roster.result.length;
      }, { timeout: 120_000, intervals: [2_000, 5_000] }).toBe(1);
      await expect.poll(async () => {
        await sdk(b, 'conversations.syncAll', {});
        return (await sdk(b, 'conversation.isActive', { id })).result;
      }, { timeout: 120_000, intervals: [2_000, 5_000] }).toBe(false);
      expect((await sdk(b, 'group.requestRemoval', { id })).error).toContain('only a member');
      await b.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(b.getByRole('region', { name: 'Room membership' })).toContainText('Your membership has ended.', { timeout: 120_000 });
      await expect(b.locator('.msg-body', { hasText: 'leave compatibility invitation' })).toBeVisible();
      await expect(b.locator('.composer-input')).toHaveCount(0);
      console.info('Leave acceptance: owner processed removal; removed installation cannot request again.');
    } finally { await Promise.all([owner.close(), member.close()]); }
  });
});

async function enable(page: Page, wallet: string) {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  const connect = page.getByRole('button', { name: 'Connect wallet', exact: true });
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(wallet);
  const button = page.getByRole('button', { name: 'Enable messaging', exact: true });
  const ready = page.getByText('Messaging enabled on this device.');
  await expect(button.or(ready)).toBeVisible({ timeout: 120_000 });
  if (await button.isVisible()) await button.click();
  await expect(ready).toBeVisible({ timeout: 120_000 });
}

// Exercise the actual browser SDK worker dispatch and WASM, without exposing a
// test API in the production app or logging keys, signatures, or message content.
async function sdk(page: Page, action: string, data: unknown): Promise<any> {
  return page.evaluate(({ action, data }) => new Promise(resolve => {
    const worker = (window as any).__leaveSdkWorker as Worker;
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { worker.removeEventListener('message', receive); resolve({ ok: false, error: 'SDK request timed out' }); }, 30_000);
    function receive(event: MessageEvent) {
      if (event.data?.id !== id) return;
      clearTimeout(timer); worker.removeEventListener('message', receive);
      resolve(event.data.error ? { ok: false, error: String(event.data.error.message ?? event.data.error) } : { ok: true, result: event.data.result });
    }
    worker.addEventListener('message', receive); worker.postMessage({ id, action, data });
  }), { action, data });
}
