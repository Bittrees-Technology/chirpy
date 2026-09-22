import { test, expect, type Page } from '@playwright/test';
const owner = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40), group = 'a'.repeat(64);
const row = (cid = 'QmLatestMessage', link: string | null = null, body = 'Preserved Push history') => ({ cid, link, fromDID: `eip155:${other}`, toDID: group, timestamp: 1000, messageType: 'Text', messageContent: body });
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, async route => {
    const url = route.request().url();
    if (url === 'https://gov.bittrees.org/api/rooms') {
      const enabled = await page.evaluate(() => (window as any).__pushFixture.catalogEnabled !== false);
      return route.fulfill({ json: { rooms: enabled ? { shareholders: group } : {}, custom: [], revision: 1 } });
    }
    if (url === 'https://research.bittrees.org/api/rooms') return route.fulfill({ json: { rooms: {}, custom: [], revision: 0 } });
    if (url.startsWith('https://api.ensideas.com/')) return route.fulfill({ json: { address: owner, name: null, avatar: null } });
    return route.abort();
  });
  await page.addInitScript(({ owner, message }) => {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const state = (window as any).__pushFixture = {
      address: owner, chain: '0x1', calls: [], signCount: 0, publicRoom: false,
      permissions: { entry: true, chat: true }, membership: { participant: true, pending: false, role: 'member' },
      pages: { latest: [message] }, hold: {}, pending: {},
      release(kind: string) { this.hold[kind] = false; for (const resolve of this.pending[kind] ?? []) resolve(); this.pending[kind] = []; },
      emit(event: string, value: any) { for (const listener of listeners.get(event) ?? []) listener(value); },
    };
    (window as any).ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [state.address];
        if (method === 'eth_chainId') return state.chain;
        if (method === 'personal_sign') { state.signCount++; return '0x' + '11'.repeat(65); }
        throw new Error('Unsupported synthetic wallet request');
      },
      on(event: string, fn: (...args: any[]) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
      removeListener(event: string, fn: (...args: any[]) => void) { listeners.get(event)?.delete(fn); },
    };
  }, { owner, message: row() });
});
async function openRoom(page: Page) {
  await page.goto('/'); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(owner);
  await page.locator('.nav-item', { hasText: 'Rooms' }).click();
  await page.getByLabel('Include existing rooms').selectOption('governance');
  await page.locator('.list-item', { hasText: 'shareholders' }).click();
}
async function enable(page: Page) {
  await page.locator('.thread').getByRole('button', { name: 'Connect Push rooms' }).click();
}
test('recovers original history and sends only through the selected Push room', async ({ page }) => {
  await openRoom(page); expect(await page.evaluate(() => (window as any).__pushFixture.signCount)).toBe(0);
  await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Write a message' }).fill('A Push message'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send'))).toEqual([{ kind: 'send', owner, room: group, extra: { type: 'Text', content: 'A Push message' } }]);
});
test('pending membership remains pending and cannot send', async ({ page }) => {
  await openRoom(page);
  await page.evaluate(() => { const s = (window as any).__pushFixture; s.publicRoom = true; s.membership.participant = false; });
  await enable(page); await page.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(page.locator('.thread-sub')).toContainText('Membership pending');
  await expect(page.getByRole('button', { name: 'Request to join', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'join').length)).toBe(1);
});
test('discards delayed history when the wallet account changes', async ({ page }) => {
  await openRoom(page); await page.evaluate(() => { (window as any).__pushFixture.hold.history = true; });
  await enable(page);
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.pending.history?.length ?? 0)).toBe(1);
  await page.evaluate(other => { const s = (window as any).__pushFixture; s.address = other; s.emit('accountsChanged', [other]); s.release('history'); }, other);
  await expect(page.locator('.thread-title')).toHaveCount(0);
  await expect(page.getByText('Preserved Push history', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pushFixture.signCount)).toBe(1);
});
test('discards delayed initialization when the room source changes', async ({ page }) => {
  await openRoom(page); await page.evaluate(() => { (window as any).__pushFixture.hold.initialize = true; });
  await enable(page);
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.pending.initialize?.length ?? 0)).toBe(1);
  await page.getByLabel('Include existing rooms').selectOption('research');
  await page.evaluate(() => (window as any).__pushFixture.release('initialize'));
  await expect(page.locator('.thread-title')).toHaveCount(0); await expect(page.getByText('Push is not connected', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'history').length)).toBe(0);
});
test('rechecks posting permission before dispatch and retains a refused draft', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Keep this draft');
  await page.evaluate(() => { (window as any).__pushFixture.permissions.chat = false; });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not allowed');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send').length)).toBe(0);
  await page.evaluate(() => { (window as any).__pushFixture.permissions.chat = true; });
  await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Keep this draft');
});
test('does not automatically retry or discard a draft after a chain change during send', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__pushFixture.hold.send = true; });
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Check history before retry');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.pending.send?.length ?? 0)).toBe(1);
  await page.evaluate(() => { const s = (window as any).__pushFixture; s.chain = '0x2'; s.emit('chainChanged', '0x2'); s.release('send'); });
  await expect(page.locator('.thread-title')).toHaveCount(0);
  await page.locator('.list-item', { hasText: 'shareholders' }).click(); await enable(page);
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Check history before retry');
  await expect(page.getByRole('alert')).toContainText('may have completed');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send').length)).toBe(1);
});
test('rechecks administrator authority before a member change', async ({ page }) => {
  await openRoom(page); await page.evaluate(() => { (window as any).__pushFixture.membership.role = 'admin'; });
  await enable(page); await page.getByText('Manage Push members', { exact: true }).click();
  await page.getByLabel('Member wallet').fill(other);
  await page.evaluate(() => { (window as any).__pushFixture.membership.role = 'member'; });
  await page.getByRole('button', { name: 'Apply member change', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'administrator' })).toBeVisible();
  await expect(page.getByText('Manage Push members', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'add').length)).toBe(0);
});
test('uses original linked history references and rejects a cross-room continuation', async ({ page }) => {
  await openRoom(page);
  await page.evaluate(({ latest, older }) => { (window as any).__pushFixture.pages = { latest: [latest], QmOlderMessage: [older] }; }, { latest: row('QmLatestMessage', 'QmOlderMessage'), older: row('QmOlderMessage', null, 'Original older message') });
  await enable(page); await page.getByRole('button', { name: 'Older messages', exact: true }).click();
  await expect(page.getByText('Original older message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Newer messages', exact: true }).click();
  await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__pushFixture.pages.QmOlderMessage[0].toDID = 'b'.repeat(64); });
  await page.getByRole('button', { name: 'Older messages', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('unsupported room history');
  await expect(page.getByText('Original older message', { exact: true })).toHaveCount(0);
});
test('refuses a write when the provider silently changes account without an event', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Must not send from the old wallet');
  await page.evaluate(other => { (window as any).__pushFixture.address = other; }, other);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.thread-title')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send').length)).toBe(0);
});

test('shows bounded member data and removes it immediately when private membership is revoked', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.evaluate(address => { (window as any).__pushFixture.members = [{ address, role: 'MEMBER', userInfo: { profile: { name: 'Do not expose this profile' } } }]; }, other);
  await page.getByText('View Push members', { exact: true }).click();
  await page.getByRole('button', { name: 'Load or refresh members' }).click();
  await expect(page.locator('.push-members code')).toHaveText(other);
  await expect(page.getByText('Do not expose this profile', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__pushFixture.membership.participant = false; });
  await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
  await expect(page.locator('.push-members')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Join this private room');
});
test('discards a delayed member list when switching sources', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.evaluate(address => { const s = (window as any).__pushFixture; s.members = [{ address, role: 'MEMBER' }]; s.hold.members = true; }, other);
  await page.getByText('View Push members', { exact: true }).click(); await page.getByRole('button', { name: 'Load or refresh members' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.pending.members?.length ?? 0)).toBe(1);
  await page.getByLabel('Include existing rooms').selectOption('research');
  await page.evaluate(() => (window as any).__pushFixture.release('members'));
  await expect(page.locator('.push-members')).toHaveCount(0); await expect(page.locator('.thread-title')).toHaveCount(0);
});

test('paginates members on mobile and restricts pending lists to administrators', async ({ page }, testInfo) => {
  await openRoom(page);
  const members = Array.from({ length: 20 }, (_, index) => ({ address: '0x' + (index + 3).toString(16).padStart(40, '0'), role: 'MEMBER' }));
  await page.evaluate(({ members, other }) => {
    const s = (window as any).__pushFixture; s.membership.role = 'admin';
    s.memberPages = { 'false:1': members, 'false:2': [{ address: other, role: 'ADMIN' }], 'true:1': [{ address: other, role: 'MEMBER' }] };
  }, { members, other });
  await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('View Push members', { exact: true }).click(); await page.getByRole('button', { name: 'Load or refresh members' }).click();
  await expect(page.locator('.push-members code')).toHaveCount(20);
  await page.locator('.push-members').getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.push-members code')).toHaveText(other);
  await expect(page.locator('.push-members').getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Member list', exact: true }).selectOption('pending');
  await expect(page.locator('.push-members')).toContainText('Page 1');
  await page.screenshot({ path: testInfo.outputPath('push-members-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.evaluate(() => { (window as any).__pushFixture.membership.role = 'member'; });
  await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Member list', exact: true })).toHaveCount(0);
  await expect(page.locator('.push-members code')).toHaveCount(0);
});
test('preserves legacy NFT ownership epochs and smart-wallet identity labels', async ({ page }) => {
  await openRoom(page);
  const nft = `nft:eip155:1:${other}:42:100`, smart = `scw:eip155:10:${other}`;
  await page.evaluate(({ nft, smart, messages }) => { const s = (window as any).__pushFixture; s.pages.latest = [{ ...messages[0], fromDID: nft }, { ...messages[1], fromDID: smart }]; }, { nft, smart, messages: [row('QmLatestMessage', 'QmOlderMessage', 'NFT historical message'), row('QmOlderMessage', null, 'Smart-wallet message')] });
  await enable(page);
  await expect(page.locator('.push-identity code')).toHaveText([smart, nft]);
  await expect(page.getByText('NFT historical message', { exact: true })).toBeVisible();
  await expect(page.getByText('Smart-wallet message', { exact: true })).toBeVisible();
});
test('reconnects the same wallet without accepting history from its disposed session', async ({ page }) => {
  await openRoom(page); await page.evaluate(() => { (window as any).__pushFixture.hold.history = true; }); await enable(page);
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.pending.history?.length ?? 0)).toBe(1);
  await page.evaluate(() => { const s = (window as any).__pushFixture; s.emit('disconnect', {}); s.hold.history = false; s.pages.latest[0].messageContent = 'After reconnect'; });
  await expect(page.locator('.thread-title')).toHaveCount(0);
  // An injected provider can reconnect with the same authorized accounts.
  // The old Push session must still require a fresh explicit enable/signature.
  await expect(page.getByText('Push is not connected', { exact: true })).toBeVisible();
  await page.locator('.list-item', { hasText: 'shareholders' }).click(); await enable(page);
  await expect(page.getByText('After reconnect', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__pushFixture.release('history'));
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'historyResult').length)).toBe(2);
  await expect(page.getByText('Preserved Push history', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pushFixture.signCount)).toBe(2);
});
test('invalidates the room session when the organization changes', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.locator('.nav-item', { hasText: 'Settings' }).click(); await page.getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import organization' });
  await dialog.getByRole('textbox').fill(JSON.stringify({ version: 1, branding: { name: 'Another organization' }, namespace: 'push-scope-test', chain: { chainId: 1 }, entryGate: [], gating: {} }));
  await dialog.getByRole('button', { name: 'Import', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.locator('.nav-item', { hasText: 'Rooms' }).click(); await expect(page.locator('.thread-title')).toHaveCount(0);
  await page.locator('.list-item', { hasText: 'shareholders' }).click(); await expect(page.locator('.thread').getByRole('button', { name: 'Connect Push rooms' })).toBeVisible();
  await expect(page.getByText('Preserved Push history', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pushFixture.signCount)).toBe(1);
});

test('replaces a provider for the same wallet without reusing its old Push session', async ({ page }) => {
  await openRoom(page); await page.evaluate(() => { (window as any).__pushFixture.hold.history = true; }); await enable(page);
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.pending.history?.length ?? 0)).toBe(1);
  await page.evaluate(() => { const s = (window as any).__pushFixture; s.replaceProvider(); s.release('history'); });
  await expect(page.locator('.thread-title')).toHaveCount(0); await expect(page.getByText('Push is not connected', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'historyResult').length)).toBe(1);
  await expect(page.getByText('Preserved Push history', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pushFixture.signCount)).toBe(1);
  await page.locator('.list-item', { hasText: 'shareholders' }).click(); await enable(page);
  await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pushFixture.signCount)).toBe(2);
});

test('does not restore a removed room or its old private history when the catalog adds it again', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__pushFixture.catalogEnabled = false; });
  await page.getByRole('button', { name: 'Refresh room list', exact: true }).click();
  await expect(page.locator('.thread-title')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__pushFixture.catalogEnabled = true; (window as any).__pushFixture.membership.participant = false; });
  await page.getByRole('button', { name: 'Refresh room list', exact: true }).click();
  await expect(page.locator('.list-item', { hasText: 'shareholders' })).toBeVisible();
  await expect(page.locator('.thread-title')).toHaveCount(0);
  await expect(page.getByText('Preserved Push history', { exact: true })).toHaveCount(0);
});
test('hides cached private history when a member-list request discovers revoked access', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByText('View Push members', { exact: true }).click();
  await page.evaluate(() => { (window as any).__pushFixture.membership.participant = false; });
  await page.getByRole('button', { name: 'Load or refresh members' }).click();
  await expect(page.locator('.thread-sub')).toContainText('Not a member');
  await expect(page.getByText('Preserved Push history', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No messages yet', { exact: true })).toHaveCount(0);
});
test('a stalled send expires, keeps its draft and cannot complete into the fresh session', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.clock.install();
  await page.evaluate(() => { (window as any).__pushFixture.hold.send = true; });
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Timed out draft');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.pending.send?.length ?? 0)).toBe(1);
  await page.clock.fastForward(30_001);
  await expect(page.locator('.thread-title')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Push took too long');
  await page.locator('.list-item', { hasText: 'shareholders' }).click(); await enable(page);
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Timed out draft');
  await page.evaluate(() => (window as any).__pushFixture.release('send'));
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Timed out draft');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send').length)).toBe(1);
});
