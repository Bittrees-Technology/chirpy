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
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
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
  // Disconnect clears Chat's wallet connection as well as the Push session.
  // An unsolicited accounts event must not reconnect either one.
  await page.evaluate(() => { const s = (window as any).__pushFixture; s.emit('accountsChanged', [s.address]); });
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).not.toHaveValue(owner);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(owner);
  await page.locator('.nav-item', { hasText: 'Rooms' }).click();
  await page.getByLabel('Include existing rooms').selectOption('governance');
  // Reconnecting the wallet must still require a fresh Push enable/signature.
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

test('downloads original Push attachments without rendering content or fetching external media', async ({ page }, testInfo) => {
  const { readFile } = await import('node:fs/promises');
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.untrustedExecuted=true"></svg>');
  const target = 'https://media.example.test/clip?private=fixture';
  let mediaRequests = 0; page.on('request', request => { if (request.url().startsWith('https://media.example.test/')) mediaRequests++; });
  await openRoom(page);
  await page.evaluate(({ messages, file, target }) => {
    const s = (window as any).__pushFixture;
    s.pages.latest = [
      {...messages[0],messageType:'File',messageObj:{content:JSON.stringify({content:'data:image/svg+xml;base64,'+file,name:'../fixture.svg'})}},
      {...messages[1],messageType:'Image',messageObj:{content:'data:image/png;base64,AQID'}},
      {...messages[2],messageType:'MediaEmbed',messageObj:{content:target}},
      {...messages[3],messageType:'File',messageObj:{content:'data:text/html,<script>window.untrustedExecuted=true</script>'}},
    ];
  },{messages:[row('QmMediaNewest','QmMediaImage'),row('QmMediaImage','QmMediaLink'),row('QmMediaLink','QmMediaBroken'),row('QmMediaBroken',null)],file:bytes.toString('base64'),target});
  await enable(page);
  await expect(page.getByRole('button',{name:'Download file',exact:true})).toHaveCount(2);
  await expect(page.getByText('This Push attachment is invalid or exceeds the 1 MB download limit.')).toBeVisible();
  const link=page.getByRole('link',{name:target,exact:true});
  await expect(link).toHaveAttribute('href',target);await expect(link).toHaveAttribute('rel','noopener noreferrer');await expect(link).toHaveAttribute('referrerpolicy','no-referrer');
  await expect(page.locator('.msg-bubble img,.msg-bubble video,.msg-bubble iframe,.msg-bubble object,.msg-bubble embed')).toHaveCount(0);
  expect(mediaRequests).toBe(0);expect(await page.evaluate(()=>(window as any).untrustedExecuted)).toBeUndefined();
  const fileCard=page.locator('.push-attachment').filter({hasText:'fixture.svg'});
  const pending=page.waitForEvent('download');await fileCard.getByRole('button',{name:'Download file',exact:true}).click();const download=await pending;
  expect(download.suggestedFilename()).toBe('__fixture.svg');const path=testInfo.outputPath('fixture.svg');await download.saveAs(path);expect(await readFile(path)).toEqual(bytes);
  expect(await page.evaluate(()=>(window as any).untrustedExecuted)).toBeUndefined();expect(mediaRequests).toBe(0);
  await page.setViewportSize({width:390,height:844});await fileCard.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('push-file-mobile.png')});
  await page.evaluate(()=>{(window as any).__pushFixture.membership.participant=false;});
  await page.getByRole('button',{name:'Refresh messages',exact:true}).click();
  await expect(page.getByRole('button',{name:'Download file',exact:true})).toHaveCount(0);await expect(link).toHaveCount(0);
});

test('preserves reply context and combined content order without fetching missing parents', async ({ page },testInfo) => {
  const {readFile}=await import('node:fs/promises');const bytes=Buffer.alloc(65536,73);
  const wire=(messageType:string,content:unknown)=>({messageType,messageObj:{content}});
  const parent='<img src=x onerror="window.untrustedReply=true"> Original message';
  await openRoom(page);
  await page.evaluate(({messages,objects})=>{(window as any).__pushFixture.pages.latest=messages.map((message:any,index:number)=>({...message,...objects[index]}));},{
    messages:[row('QmCombinedMessage','QmMissingReply'),row('QmMissingReply','QmPresentReply'),row('QmPresentReply','QmParentMessage'),row('QmParentMessage',null,parent)],
    objects:[
      {messageType:'Composite',messageObj:{content:[wire('Text','Caption before'),wire('File',JSON.stringify({name:'combined.bin',content:'data:application/octet-stream;base64,'+bytes.toString('base64')})),wire('MediaEmbed','https://media.example.test/combined'),wire('Text','Caption after')]}},
      {messageType:'Reply',messageObj:{content:wire('Text','Reply without loaded parent'),reference:'QmAbsentParent'}},
      {messageType:'Reply',messageObj:{content:wire('Text','Reply with loaded parent'),reference:'QmParentMessage'}},{}
    ]
  });
  await enable(page);
  await expect(page.locator('.msg-reply-ref')).toHaveText(['↩ '+parent.slice(0,60),'↩ Original message is not on this page']);
  const combined=page.locator('.msg-row').filter({hasText:'Caption before'});
  const parts=combined.locator('.push-message-parts > div');await expect(parts).toHaveCount(4);
  await expect(parts.nth(0)).toHaveText('Caption before');await expect(parts.nth(1)).toContainText('combined.bin');await expect(parts.nth(2)).toContainText('https://media.example.test/combined');await expect(parts.nth(3)).toHaveText('Caption after');
  const pending=page.waitForEvent('download');await combined.getByRole('button',{name:'Download file',exact:true}).click();const download=await pending;const path=testInfo.outputPath('combined.bin');await download.saveAs(path);expect((await readFile(path)).equals(bytes)).toBe(true);
  expect(await page.evaluate(()=>(window as any).untrustedReply)).toBeUndefined();await expect(page.locator('.msg-bubble img')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__pushFixture.calls.filter((call:any)=>call.kind==='history').length)).toBe(1);
  await page.setViewportSize({width:390,height:844});await combined.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('push-combined-mobile.png')});
  await page.evaluate(address=>{const s=(window as any).__pushFixture;s.address=address;s.emit('accountsChanged',[address]);},other);
  await expect(page.locator('.msg-reply-ref')).toHaveCount(0);await expect(page.getByRole('button',{name:'Download file',exact:true})).toHaveCount(0);await expect(page.getByText('Caption before',{exact:true})).toHaveCount(0);
});

for (const mobile of [false, true]) {
  test(`composes a Push reply with a retained original excerpt across pages (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
    await openRoom(page);
    await page.evaluate(({ latest, older }) => { const s = (window as any).__pushFixture; s.pages = { latest: [latest], QmOlderMessage: [older], QmLatestMessage: [latest] }; }, { latest: row('QmLatestMessage', 'QmOlderMessage'), older: row('QmOlderMessage', null, 'Older original') });
    await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.locator('.reply-banner')).toContainText('Preserved Push history');
    await page.getByRole('button', { name: 'Older messages', exact: true }).click();
    await expect(page.getByText('Older original', { exact: true })).toBeVisible();
    await expect(page.locator('.reply-banner')).toContainText('Preserved Push history');
    await page.getByRole('textbox', { name: 'Write a message' }).fill('A contextual reply');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('push-reply-compose.png') });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('');
    await expect(page.locator('.reply-banner')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send'))).toEqual([{ kind: 'send', owner, room: group, extra: { type: 'Reply', content: { type: 'Text', content: 'A contextual reply' }, reference: 'QmLatestMessage' } }]);
    expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'history' && c.extra.limit === 1))).toEqual([{ kind: 'history', owner, room: group, extra: { reference: 'QmLatestMessage', limit: 1 } }]);
  });
}
test('canceling a reply retains the draft and sends plain text only by that choice', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Keep the draft');
  await page.getByRole('button', { name: 'Cancel reply' }).click();
  await expect(page.locator('.reply-banner')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Write a message' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send').map((c: any) => c.extra))).toEqual([{ type: 'Text', content: 'Keep the draft' }]);
});
test('a foreign parent refuses reply dispatch and keeps the draft and selection for explicit retry', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Reply draft');
  await page.evaluate(message => { (window as any).__pushFixture.pages.QmLatestMessage = [message]; }, { ...row(), toDID: 'b'.repeat(64) });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('unsupported room history');
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Reply draft');
  await expect(page.locator('.reply-banner')).toContainText('Preserved Push history');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send'))).toEqual([]);
  await page.evaluate(message => { (window as any).__pushFixture.pages.QmLatestMessage = [message]; }, row());
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send').map((c: any) => c.extra.type))).toEqual(['Reply']);
});
for (const change of ['wallet', 'source', 'permission']) {
  test(`reply parent lookup cannot send or retain a private excerpt after ${change} changes`, async ({ page }) => {
    await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.getByRole('textbox', { name: 'Write a message' }).fill('Do not send');
    await page.evaluate(message => { const s = (window as any).__pushFixture; s.pages.QmLatestMessage = [message]; s.hold.history = true; }, row());
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.pending.history?.length ?? 0)).toBe(1);
    if (change === 'wallet') await page.evaluate(other => { const s = (window as any).__pushFixture; s.address = other; s.emit('accountsChanged', [other]); }, other);
    if (change === 'source') await page.getByLabel('Include existing rooms').selectOption('research');
    if (change === 'permission') await page.evaluate(() => { (window as any).__pushFixture.permissions.chat = false; });
    await page.evaluate(() => (window as any).__pushFixture.release('history'));
    await expect(page.locator('.reply-banner')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send'))).toEqual([]);
  });
}
test('completion of an earlier reply preserves a newly chosen target and edited draft', async ({ page }) => {
  await openRoom(page);
  await page.evaluate(({ latest, older }) => { const s = (window as any).__pushFixture; s.pages = { latest: [latest, older], QmLatestMessage: [latest] }; s.hold.send = true; }, { latest: row('QmLatestMessage', 'QmOlderMessage'), older: row('QmOlderMessage', null, 'Another original') });
  await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.locator('.msg-row').filter({ hasText: 'Preserved Push history' }).getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('First reply');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pushFixture.pending.send?.length ?? 0)).toBe(1);
  await page.locator('.msg-row').filter({ hasText: 'Another original' }).getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Next reply');
  await page.evaluate(() => (window as any).__pushFixture.release('send'));
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(page.locator('.reply-banner')).toContainText('Another original');
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Next reply');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send').length)).toBe(1);
});

for (const caption of ['', 'A caption for the selected file']) {
  test(`sends original file bytes with ${caption ? 'a caption' : 'no caption'} and downloads its history copy`, async ({ page }, testInfo) => {
    const { readFile } = await import('node:fs/promises');
    const bytes = Buffer.from(Array.from({ length: 262144 }, (_, i) => i % 256));
    await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
    await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'chosen.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await expect(page.locator('.push-file-compose')).toContainText('chosen.bin');
    await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled();
    if (caption) await page.getByRole('textbox', { name: 'Write a message' }).fill(caption);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('push-file-compose-mobile.png') });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.push-file-compose strong')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('');
    const sent = await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send'));
    expect(sent).toHaveLength(1); expect(sent[0].room).toBe(group); expect(sent[0].owner).toBe(owner);
    const payload = sent[0].extra;
    expect(payload.type).toBe(caption ? 'Composite' : 'File');
    const file = caption ? payload.content[1] : payload;
    if (caption) expect(payload.content[0]).toEqual({ type: 'Text', content: caption });
    expect(file.type).toBe('File'); const data = JSON.parse(file.content); expect(data.name).toBe('chosen.bin');
    expect(Buffer.from(data.content.split(',')[1], 'base64').equals(bytes)).toBe(true);
    // Emulate the documented stored envelope at the external SDK boundary.
    await page.evaluate(({ payload, message }) => {
      const content = payload.type === 'Composite' ? payload.content.map((p: any) => ({ messageType: p.type, messageObj: { content: p.content } })) : payload.content;
      (window as any).__pushFixture.pages.latest = [{ ...message, messageType: payload.type, messageObj: { content } }];
    }, { payload, message: row('QmUploadedFile') });
    await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download file', exact: true }).click();
    const download = await pending, destination = testInfo.outputPath('received.bin'); await download.saveAs(destination);
    expect((await readFile(destination)).equals(bytes)).toBe(true);
  });
}
test('enforces the file boundary before reading, supports removal, and allows choosing the same file again', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'too-large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1000001) });
  await expect(page.getByRole('alert')).toContainText('at most 1 MB'); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  const maximum = { name: 'max.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1000000, 31) };
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(maximum);
  await expect(page.locator('.push-file-compose strong')).toHaveText('max.bin');
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Keep this caption');
  await page.getByRole('button', { name: 'Remove file', exact: true }).click();
  await expect(page.locator('.push-file-compose strong')).toHaveCount(0); await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Keep this caption');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(maximum);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(page.locator('.push-file-compose strong')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send').length)).toBe(1);
});
test('a rejected file send retains the selection and caption without automatic retry', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await expect(page.locator('.push-file-compose strong')).toHaveText('retry.txt');
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Kept caption');
  await page.evaluate(() => { (window as any).__pushFixture.failSend = true; });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Refresh history or membership before retrying');
  await expect(page.locator('.push-file-compose strong')).toHaveText('retry.txt');
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Kept caption');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send').length)).toBe(1);
});
for (const change of ['source', 'wallet', 'permission']) {
  test(`discards a delayed local file read after a ${change} change`, async ({ page }) => {
    await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () { return new Promise<ArrayBuffer>((resolve, reject) => { (window as any).__releaseFile = () => original.call(this).then(resolve, reject); }); };
    });
    await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'private.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('private') });
    await expect(page.getByRole('button', { name: 'Preparing files…', exact: true })).toBeVisible();
    if (change === 'source') await page.getByLabel('Include existing rooms').selectOption('research');
    if (change === 'wallet') await page.evaluate(other => { const s = (window as any).__pushFixture; s.address = other; s.emit('accountsChanged', [other]); }, other);
    if (change === 'permission') {
      await page.evaluate(() => { (window as any).__pushFixture.permissions.chat = false; });
      await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveCount(0);
    }
    await page.evaluate(() => (window as any).__releaseFile());
    await expect(page.locator('.push-file-compose')).toHaveCount(0);
    await expect(page.getByText('private.bin', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send'))).toEqual([]);
  });
}
test('keeps file-heavy history readable with smaller linked pages and stable revisits', async ({ page }) => {
  await openRoom(page);
  await page.evaluate(({ group, other }) => {
    const content = 'data:application/octet-stream;base64,' + btoa('x'.repeat(1_000_000));
    const rows = Array.from({ length: 8 }, (_, i) => ({ cid: `QmLargeFile${i}`, link: i === 7 ? null : `QmLargeFile${i + 1}`, fromDID: other, toDID: group, timestamp: i, messageType: 'File', messageObj: { content: JSON.stringify({ name: `file-${i}.bin`, content }) } }));
    const pages: Record<string, unknown> = { latest: rows }; rows.forEach((row, i) => { pages[row.cid] = rows.slice(i); });
    (window as any).__pushFixture.pages = pages;
  }, { group, other });
  await enable(page); await expect(page.locator('.push-attachment strong')).toHaveText(['file-3.bin', 'file-2.bin', 'file-1.bin', 'file-0.bin']);
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'history').map((c: any) => c.extra.limit))).toEqual([30, 4]);
  await page.getByRole('button', { name: 'Older messages', exact: true }).click();
  await expect(page.locator('.push-attachment strong')).toHaveText(['file-7.bin', 'file-6.bin', 'file-5.bin', 'file-4.bin']);
  await expect(page.getByRole('button', { name: 'Older messages', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Newer messages', exact: true }).click();
  await expect(page.locator('.push-attachment strong')).toHaveText(['file-3.bin', 'file-2.bin', 'file-1.bin', 'file-0.bin']);
  await expect(page.getByRole('alert')).toHaveCount(0);
});


for (const first of ['reply', 'file']) {
  test(`sends a file reply when selecting the ${first} first`, async ({ page }, testInfo) => {
    const { readFile } = await import('node:fs/promises');
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
    if (first === 'reply') await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'reply.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await expect(page.locator('.push-file-compose strong')).toHaveText('reply.bin');
    if (first === 'file') await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.locator('.reply-banner')).toContainText('Preserved Push history');
    await page.evaluate(message => { (window as any).__pushFixture.pages.QmLatestMessage = [message]; }, row());
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('push-file-reply-mobile.png') });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.push-file-compose strong')).toHaveCount(0); await expect(page.locator('.reply-banner')).toHaveCount(0);
    const sent = await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send'));
    expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ owner, room: group, extra: { type: 'Reply', reference: 'QmLatestMessage', content: { type: 'File' } } });
    const payload = sent[0].extra, data = JSON.parse(payload.content.content);
    expect(data.name).toBe('reply.bin'); expect(Buffer.from(data.content.split(',')[1], 'base64').equals(bytes)).toBe(true);
    await page.evaluate(({ payload, message }) => {
      (window as any).__pushFixture.pages.latest = [{ ...message, messageType: 'Reply', messageObj: { reference: payload.reference, content: { messageType: payload.content.type, messageObj: { content: payload.content.content } } } }];
    }, { payload, message: row('QmFileReply') });
    await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
    await expect(page.locator('.msg-reply-ref')).toHaveText('↩ Original message is not on this page');
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download file', exact: true }).click();
    const download = await pending, destination = testInfo.outputPath('reply.bin'); await download.saveAs(destination);
    expect((await readFile(destination)).equals(bytes)).toBe(true);
  });
}
test('explains caption limits without dropping the selected file, reply, or text', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Do not lose this caption');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'captioned.txt', mimeType: 'text/plain', buffer: Buffer.from('file') });
  await expect(page.getByRole('status').filter({ hasText: 'File replies cannot include a caption' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Write a message' }).press('Enter');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send'))).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Do not lose this caption');
  await expect(page.locator('.reply-banner')).toContainText('Preserved Push history');
  await expect(page.locator('.push-file-compose strong')).toHaveText('captioned.txt');
  await page.getByRole('button', { name: 'Cancel reply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.push-file-compose strong')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send').map((c: any) => c.extra.type))).toEqual(['Composite']);
});
test('retains a rejected file reply for an explicit retry and clears it on lost access', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'private-reply.txt', mimeType: 'text/plain', buffer: Buffer.from('private') });
  await expect(page.locator('.push-file-compose strong')).toHaveText('private-reply.txt');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Choose an original message');
  await expect(page.locator('.reply-banner')).toContainText('Preserved Push history');
  await expect(page.locator('.push-file-compose strong')).toHaveText('private-reply.txt');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((c: any) => c.kind === 'send'))).toEqual([]);
  await page.evaluate(() => { (window as any).__pushFixture.permissions.chat = false; });
  await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
  await expect(page.locator('.reply-banner')).toHaveCount(0); await expect(page.locator('.push-file-compose')).toHaveCount(0);
});

async function previewImages(page: Page) {
  await page.evaluate(({ group, other }) => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 120;
    const context = canvas.getContext('2d')!; context.fillStyle = '#f7931a'; context.fillRect(0,0,240,120); context.fillStyle = '#184b72'; context.fillRect(30,30,180,60);
    const png = canvas.toDataURL('image/png'), jpeg = canvas.toDataURL('image/jpeg');
    (window as any).__imageFixture = { png, jpeg, created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); (window as any).__imageFixture.created.push(url); return url; };
    URL.revokeObjectURL = url => { (window as any).__imageFixture.revoked.push(url); revoke(url); };
    (window as any).__pushFixture.pages.latest = [png,jpeg].map((content,i) => ({ cid:`QmPreviewImage${i}`,link:i===0?'QmPreviewImage1':null,fromDID:other,toDID:group,timestamp:i,messageType:'File',messageObj:{content:JSON.stringify({name:i===0?'sample.png':'sample.jpg',content})} }));
  }, { group, other });
}
test('opens one local image preview at a time, hides and releases it, and downloads original bytes', async ({ page }, testInfo) => {
  const { readFile } = await import('node:fs/promises');
  await openRoom(page); await previewImages(page); await enable(page);
  await expect(page.getByRole('button', { name: 'Preview image', exact: true })).toHaveCount(2);
  await expect(page.locator('.push-image-preview')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__imageFixture.created)).toEqual([]);
  const png = page.locator('.push-attachment').filter({ hasText: 'sample.png' }), jpeg = page.locator('.push-attachment').filter({ hasText: 'sample.jpg' });
  await png.getByRole('button', { name: 'Preview image', exact: true }).click();
  await expect(png.locator('img')).toBeVisible(); await expect.poll(() => png.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
  await expect(png.locator('img')).toHaveAttribute('src', /^blob:/);
  await jpeg.getByRole('button', { name: 'Preview image', exact: true }).click();
  await expect(png.locator('img')).toHaveCount(0); await expect(page.locator('.push-image-preview')).toHaveCount(1);
  await expect.poll(() => jpeg.locator('img').evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(120);
  expect(await page.evaluate(() => { const s=(window as any).__imageFixture; return s.revoked.includes(s.created[0]); })).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 }); await jpeg.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path:testInfo.outputPath('push-image-preview-mobile.png') });
  await jpeg.getByRole('button', { name: 'Hide preview', exact: true }).click(); await expect(page.locator('.push-image-preview')).toHaveCount(0);
  expect(await page.evaluate(() => { const s=(window as any).__imageFixture; return s.created.every((url:string)=>s.revoked.includes(url)); })).toBe(true);
  const pending=page.waitForEvent('download'); await png.getByRole('button',{name:'Download file',exact:true}).click();
  const download=await pending,path=testInfo.outputPath('original.png'); await download.saveAs(path);
  const original=await page.evaluate(()=>(window as any).__imageFixture.png.split(',')[1]); expect((await readFile(path)).equals(Buffer.from(original,'base64'))).toBe(true);
});
for (const change of ['source','wallet','membership']) {
  test(`removes and releases an open image preview on ${change} change`, async ({ page }) => {
    await openRoom(page); await previewImages(page); await enable(page);
    await page.locator('.push-attachment').filter({ hasText:'sample.png' }).getByRole('button',{name:'Preview image',exact:true}).click();
    await expect(page.locator('.push-image-preview')).toBeVisible();
    if (change==='source') await page.getByLabel('Include existing rooms').selectOption('research');
    if (change==='wallet') await page.evaluate(other=>{const s=(window as any).__pushFixture;s.address=other;s.emit('accountsChanged',[other]);},other);
    if (change==='membership') { await page.evaluate(()=>{(window as any).__pushFixture.membership.participant=false;}); await page.getByRole('button',{name:'Refresh messages',exact:true}).click(); }
    await expect(page.locator('.push-image-preview')).toHaveCount(0);
    expect(await page.evaluate(()=>{const s=(window as any).__imageFixture;return s.created.every((url:string)=>s.revoked.includes(url));})).toBe(true);
  });
}
test('rejects malformed raster contents without a blob, and never previews SVG or external URLs', async ({ page }) => {
  await openRoom(page); await previewImages(page);
  await page.evaluate(({group,other})=>{
    const content=[JSON.stringify({name:'bad.png',content:'data:image/png;base64,'+btoa('<svg onload="window.badPreview=true"/>')}),JSON.stringify({name:'active.svg',content:'data:image/svg+xml;base64,'+btoa('<svg/>')}),'https://media.example.test/tracker.png'];
    (window as any).__pushFixture.pages.latest=content.map((content,i)=>({cid:`QmUnsafeImage${i}`,link:i<2?`QmUnsafeImage${i+1}`:null,fromDID:other,toDID:group,timestamp:i,messageType:i===2?'MediaEmbed':'File',messageObj:{content}}));
  },{group,other});
  let externalImages=0;page.on('request',r=>{if(r.url().startsWith('https://media.example.test/'))externalImages++;});
  await enable(page); await expect(page.getByRole('button',{name:'Preview image',exact:true})).toHaveCount(1);
  await page.getByRole('button',{name:'Preview image',exact:true}).click(); await expect(page.getByRole('alert')).toContainText('cannot be previewed');
  await expect(page.locator('.push-image-preview')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__imageFixture.created)).toEqual([]);expect(await page.evaluate(()=>(window as any).badPreview)).toBeUndefined();expect(externalImages).toBe(0);
});
test('requires a new click when a refreshed attachment changes instead of reusing preview consent', async ({ page }) => {
  await openRoom(page); await previewImages(page); await enable(page);
  const png=page.locator('.push-attachment').filter({hasText:'sample.png'});
  await png.getByRole('button',{name:'Preview image',exact:true}).click();await expect(page.locator('.push-image-preview')).toBeVisible();
  await page.evaluate(()=>{const c=document.createElement('canvas');c.width=100;c.height=50;c.getContext('2d')!.fillRect(0,0,100,50);(window as any).__pushFixture.pages.latest[0].messageObj.content=JSON.stringify({name:'sample.png',content:c.toDataURL('image/png')});});
  await page.getByRole('button',{name:'Refresh messages',exact:true}).click();
  await expect(page.locator('.push-image-preview')).toHaveCount(0);await expect(png.getByRole('button',{name:'Preview image',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>{const s=(window as any).__imageFixture;return s.created.length===1&&s.revoked.includes(s.created[0]);})).toBe(true);
  await png.getByRole('button',{name:'Preview image',exact:true}).click();await expect.poll(()=>png.locator('img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(100);
});

test('releases a preview rejected by the browser decoder and keeps the original download available', async ({ page }, testInfo) => {
  const { readFile } = await import('node:fs/promises');
  await openRoom(page); await previewImages(page);
  const original = await page.evaluate(() => {
    const s=(window as any).__pushFixture, file=JSON.parse(s.pages.latest[1].messageObj.content);
    const bytes=Uint8Array.from(atob(file.content.split(',')[1]),c=>c.charCodeAt(0));
    // Retain valid marker framing and dimensions, but use an invalid JPEG
    // quantization-table selector. Chromium rejects this during pixel decode.
    for(let offset=2;offset<bytes.length;) {
      const marker=bytes[offset+1],length=bytes[offset+2]*256+bytes[offset+3];
      if(marker===219) { bytes[offset+4]=255; break; }
      if(marker===218) throw Error('JPEG fixture has no quantization table');
      offset+=length+2;
    }
    const base64=btoa(String.fromCharCode(...bytes));
    file.content='data:image/jpeg;base64,'+base64;s.pages.latest[1].messageObj.content=JSON.stringify(file);
    return base64;
  });
  await enable(page);const jpeg=page.locator('.push-attachment').filter({hasText:'sample.jpg'});
  await jpeg.getByRole('button',{name:'Preview image',exact:true}).click();await expect(jpeg.getByRole('alert')).toContainText('cannot be previewed');
  await expect(page.locator('.push-image-preview')).toHaveCount(0);await expect(jpeg.getByRole('button',{name:'Download file',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>{const s=(window as any).__imageFixture;return s.created.length===1&&s.revoked.includes(s.created[0]);})).toBe(true);
  const pending=page.waitForEvent('download');await jpeg.getByRole('button',{name:'Download file',exact:true}).click();
  const download=await pending,path=testInfo.outputPath('original-rejected.jpg');await download.saveAs(path);
  expect((await readFile(path)).equals(Buffer.from(original,'base64'))).toBe(true);
});

async function reactionHistory(page: Page) {
 await page.evaluate(({owner,other,group})=>{
  const original={cid:'QmReactionOriginal',link:null,fromDID:other,toDID:group,timestamp:0,messageType:'Text',messageContent:'Original with reactions'};
  const event=(cid:string,link:string,sender:string,emoji:string)=>({cid,link,fromDID:sender,toDID:group,timestamp:1,messageType:'Reaction',messageObj:{content:emoji,reference:original.cid}});
  (window as any).__pushFixture.pages={latest:[event('QmReactionNewest','QmReactionDuplicate',owner,'👍'),event('QmReactionDuplicate','QmReactionOther',owner,'👍'),event('QmReactionOther',original.cid,other,'❤️')],QmReactionOriginal:[original]};
 },{owner,other,group});
}
test('preserves reaction-only pages and carries deduplicated counts to older originals and back',async({page},testInfo)=>{
 await openRoom(page);await reactionHistory(page);await enable(page);
 await expect(page.locator('.push-reaction-event')).toHaveCount(3);await expect(page.getByRole('button',{name:'Reply',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Older messages',exact:true}).click();await expect(page.getByText('Original with reactions',{exact:true})).toBeVisible();
 await expect(page.locator('.reaction-chip')).toHaveText(['❤️ 1','👍 1']);
 await page.locator('.push-reaction-controls summary').click();
 await expect(page.getByRole('button',{name:'React with 👍',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'React with ❤️',exact:true})).toBeEnabled();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const bubble=await page.locator('.msg-bubble').boundingBox(),picker=await page.locator('.push-reaction-controls').boundingBox();expect(picker!.y).toBeGreaterThanOrEqual(bubble!.y+bubble!.height);
 const target=await page.getByRole('button',{name:'React with ❤️',exact:true}).boundingBox();expect(target!.width).toBeGreaterThanOrEqual(44);expect(target!.height).toBeGreaterThanOrEqual(44);
 await page.screenshot({path:testInfo.outputPath('push-reactions-mobile.png')});
 await page.getByRole('button',{name:'Newer messages',exact:true}).click();await expect(page.locator('.push-reaction-event')).toHaveCount(3);
 await page.getByRole('button',{name:'Older messages',exact:true}).click();await expect(page.locator('.reaction-chip')).toHaveText(['❤️ 1','👍 1']);
});
test('sends one native reaction to a room-bound original and waits for history instead of inventing a count',async({page})=>{
 await openRoom(page);await page.evaluate(()=>{const s=(window as any).__pushFixture;s.pages.QmLatestMessage=[...s.pages.latest];s.hold.send=true;});await enable(page);
 await page.locator('.push-reaction-controls summary').click();await page.getByRole('button',{name:'React with 🔥',exact:true}).click();
 await expect(page.getByText('Adding reaction…',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'React with 👍',exact:true})).toBeDisabled();await expect(page.locator('.reaction-chip')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__pushFixture.calls.filter((c:any)=>c.kind==='send'))).toEqual([{kind:'send',room:group,owner,extra:{type:'Reaction',content:'🔥',reference:'QmLatestMessage'}}]);
 await page.evaluate(({owner,group})=>{const s=(window as any).__pushFixture;s.pages.latest.unshift({cid:'QmPostedReaction',link:'QmLatestMessage',fromDID:owner,toDID:group,timestamp:2,messageType:'Reaction',messageObj:{content:'🔥',reference:'QmLatestMessage'}});s.release('send');},{owner,group});
 await expect(page.locator('.reaction-chip')).toHaveText(['🔥 1']);await expect(page.locator('.push-reaction-event')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__pushFixture.calls.filter((c:any)=>c.kind==='send').length)).toBe(1);
});
test('reports an uncertain reaction without retrying or displaying an invented reaction',async({page})=>{
 await openRoom(page);await page.evaluate(()=>{const s=(window as any).__pushFixture;s.pages.QmLatestMessage=[...s.pages.latest];s.failSend=true;});await enable(page);
 await page.locator('.push-reaction-controls summary').click();await page.getByRole('button',{name:'React with 👍',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Refresh latest messages');await expect(page.locator('.reaction-chip')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__pushFixture.calls.filter((c:any)=>c.kind==='send').length)).toBe(1);
});
for(const change of ['source','wallet','permission'])test(`rejects a delayed reaction original after ${change} changes`,async({page})=>{
 await openRoom(page);await enable(page);await expect(page.getByText('Preserved Push history',{exact:true})).toBeVisible();await page.evaluate(()=>{const s=(window as any).__pushFixture;s.pages.QmLatestMessage=[...s.pages.latest];s.hold.history=true;});
 await page.locator('.push-reaction-controls summary').click();await page.getByRole('button',{name:'React with 👍',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__pushFixture.pending.history?.length??0)).toBe(1);
 if(change==='source')await page.getByLabel('Include existing rooms').selectOption('research');
 if(change==='wallet')await page.evaluate(other=>{const s=(window as any).__pushFixture;s.address=other;s.emit('accountsChanged',[other]);},other);
 if(change==='permission')await page.evaluate(()=>{(window as any).__pushFixture.permissions.chat=false;});
 await page.evaluate(()=>(window as any).__pushFixture.release('history'));
 if(change==='permission')await expect(page.locator('.push-reaction-controls')).toHaveCount(0);else await expect(page.locator('.thread-title')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__pushFixture.calls.filter((c:any)=>c.kind==='send'))).toEqual([]);
 await expect(page.getByText('The reaction could not be confirmed.',{exact:false})).toHaveCount(0);
});
test('clears visible reaction counts when private room membership is lost',async({page})=>{
 await openRoom(page);await reactionHistory(page);await enable(page);await page.getByRole('button',{name:'Older messages',exact:true}).click();await expect(page.locator('.reaction-chip')).toHaveCount(2);
 await page.evaluate(()=>{(window as any).__pushFixture.membership.participant=false;});await page.getByRole('button',{name:'Latest messages',exact:true}).click();
 await expect(page.locator('.reaction-chip')).toHaveCount(0);await expect(page.getByText('Original with reactions',{exact:true})).toHaveCount(0);
});
test('discards a retired reaction completion without retrying into the replacement source',async({page})=>{
 await openRoom(page);await enable(page);await expect(page.getByText('Preserved Push history',{exact:true})).toBeVisible();
 await page.evaluate(()=>{const s=(window as any).__pushFixture;s.pages.QmLatestMessage=[...s.pages.latest];s.hold.send=true;s.failSend=true;});
 await page.locator('.push-reaction-controls summary').click();await page.getByRole('button',{name:'React with 👍',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__pushFixture.pending.send?.length??0)).toBe(1);
 await page.getByLabel('Include existing rooms').selectOption('research');await page.evaluate(()=>(window as any).__pushFixture.release('send'));
 await expect(page.locator('.thread-title')).toHaveCount(0);await expect(page.locator('.reaction-chip')).toHaveCount(0);await expect(page.locator('.push-reaction-controls')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__pushFixture.calls.filter((c:any)=>c.kind==='send').length)).toBe(1);
 await expect(page.getByText('The reaction could not be confirmed.',{exact:false})).toHaveCount(0);
});

for (const caption of ['', 'A caption for both files']) {
  test(`sends multiple files in one message ${caption ? 'with' : 'without'} a caption and downloads exact copies`, async ({ page }, testInfo) => {
    const { readFile } = await import('node:fs/promises');
    const files = [
      { name: 'first.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(Array.from({ length: 262144 }, (_, i) => i % 256)) },
      { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('Second file, distinct exact bytes.\n') },
    ];
    await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(files);
    await expect(page.locator('.push-file-compose strong')).toHaveText(files.map(file => file.name));
    if (caption) await page.getByRole('textbox', { name: 'Write a message' }).fill(caption);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const button of await page.locator('.push-file-selection button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('push-multiple-files-mobile.png') });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.push-file-compose strong')).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send'));
    expect(calls).toHaveLength(1); expect(calls[0].owner).toBe(owner); expect(calls[0].room).toBe(group);
    const payload = calls[0].extra; expect(payload.type).toBe('Composite'); expect(payload.content).toHaveLength(files.length + (caption ? 1 : 0));
    if (caption) expect(payload.content[0]).toEqual({ type: 'Text', content: caption });
    payload.content.slice(caption ? 1 : 0).forEach((part: any, index: number) => {
      const file = JSON.parse(part.content); expect(part.type).toBe('File'); expect(file.name).toBe(files[index].name);
      expect(Buffer.from(file.content.split(',')[1], 'base64').equals(files[index].buffer)).toBe(true);
    });
    await page.evaluate(({ payload, message }) => {
      (window as any).__pushFixture.pages.latest = [{ ...message, messageType: 'Composite', messageObj: {
        content: payload.content.map((part: any) => ({ messageType: part.type, messageObj: { content: part.content } })),
      } }];
    }, { payload, message: row('QmMultipleUploadedFiles') });
    await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
    await expect(page.locator('.push-attachment strong')).toHaveText(files.map(file => file.name));
    for (const file of files) {
      const pending = page.waitForEvent('download');
      await page.locator('.push-attachment').filter({ has: page.getByText(file.name, { exact: true }) }).getByRole('button', { name: 'Download file', exact: true }).click();
      const download = await pending, destination = testInfo.outputPath(file.name); await download.saveAs(destination);
      expect((await readFile(destination)).equals(file.buffer)).toBe(true);
    }
  });
}
test('adds and removes individual files without collapsing matching filenames or losing the caption', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  const file = (text: string) => ({ name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(file('first'));
  await expect(page.locator('.push-file-compose strong')).toHaveCount(1);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(file('second'));
  await expect(page.locator('.push-file-compose strong')).toHaveText(['same.txt', 'same.txt']);
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Keep caption');
  await page.getByRole('button', { name: 'Remove file: same.txt (1)', exact: true }).click();
  await expect(page.locator('.push-file-compose strong')).toHaveText('same.txt');
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Keep caption');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.push-file-compose strong')).toHaveCount(0);
  const sent = await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send'));
  expect(sent).toHaveLength(1);
  expect(Buffer.from(JSON.parse(sent[0].extra.content[1].content).content.split(',')[1], 'base64').toString()).toBe('second');
});
test('rejects an entire invalid batch before reading and preserves prior files after a later read failure', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  const prior = { name: 'prior.txt', mimeType: 'text/plain', buffer: Buffer.from('keep') };
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(prior);
  await expect(page.locator('.push-file-compose strong')).toHaveText('prior.txt');
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer; (window as any).__fileReads = [];
    File.prototype.arrayBuffer = function () {
      (window as any).__fileReads.push(this.name);
      if (this.name === 'unreadable.txt') return Promise.reject(new Error('Synthetic read failure'));
      return original.call(this);
    };
  });
  await page.getByLabel('Attach files', { exact: true }).setInputFiles([prior, { ...prior, name: 'large.bin', buffer: Buffer.alloc(1_000_001) }]);
  await expect(page.getByRole('alert')).toContainText('at most 1 MB');
  expect(await page.evaluate(() => (window as any).__fileReads)).toEqual([]);
  await expect(page.locator('.push-file-compose strong')).toHaveText('prior.txt');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles([{ ...prior, name: 'new.txt' }, { ...prior, name: 'unreadable.txt' }]);
  await expect(page.getByRole('alert')).toContainText('Synthetic read failure');
  expect(await page.evaluate(() => (window as any).__fileReads)).toEqual(['new.txt', 'unreadable.txt']);
  await expect(page.locator('.push-file-compose strong')).toHaveText('prior.txt');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send'))).toEqual([]);
});
test('enforces six files for initial and additional selections without changing the accepted selection', async ({ page }, testInfo) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  const files = Array.from({ length: 7 }, (_, index) => ({ name: index ? `${index}.txt` : 'long-' + 'a'.repeat(100) + '.txt', mimeType: 'text/plain', buffer: Buffer.from(`file ${index}`) }));
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(files);
  await expect(page.getByRole('alert')).toContainText('at most 6 files'); await expect(page.locator('.push-file-compose strong')).toHaveCount(0);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(files.slice(0, 6));
  await expect(page.locator('.push-file-compose strong')).toHaveText(files.slice(0, 6).map(file => file.name));
  await page.setViewportSize({ width: 390, height: 667 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const membersBox = await page.locator('.push-members').boundingBox();
  const membersLabel = await page.locator('.push-members summary').boundingBox();
  expect(membersBox!.y + membersBox!.height).toBeGreaterThanOrEqual(membersLabel!.y + membersLabel!.height);
  const sendBox = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
  expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(600);
  const selection = page.getByRole('list', { name: 'Selected files', exact: true });
  expect(await selection.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(page.getByText('Selected files (6/6)', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('push-six-files-mobile.png') });
  await page.getByRole('button', { name: 'Attach files', exact: true }).focus();
  for (let index = 0; index < 6; index++) await page.keyboard.press('Tab');
  const lastRemoval = selection.getByRole('button').last();
  await expect(lastRemoval).toBeFocused();
  const lastBox = await lastRemoval.boundingBox(), listBox = await selection.boundingBox();
  expect(lastBox!.y).toBeGreaterThanOrEqual(listBox!.y);
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(listBox!.y + listBox!.height + 1);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(files[6]);
  await expect(page.getByRole('alert')).toContainText('at most 6 files'); await expect(page.locator('.push-file-compose strong')).toHaveCount(6);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(page.locator('.push-file-compose strong')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send'));
  expect(calls).toHaveLength(1); expect(calls[0].extra.content).toHaveLength(6);
});
for (const first of ['reply', 'files']) {
  test(`preserves multiple files and a reply when selecting ${first} first until the conflict is resolved`, async ({ page }) => {
    await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
    if (first === 'reply') await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(['first', 'second'].map(name => ({ name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from(name) })));
    await expect(page.locator('.push-file-compose strong')).toHaveCount(2);
    if (first === 'files') await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Replies support one file' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.getByRole('textbox', { name: 'Write a message' }).press('Enter');
    expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send'))).toEqual([]);
    await expect(page.locator('.reply-banner')).toContainText('Preserved Push history'); await expect(page.locator('.push-file-compose strong')).toHaveCount(2);
    await page.evaluate(message => { (window as any).__pushFixture.pages.QmLatestMessage = [message]; }, row());
    if (first === 'reply') await page.getByRole('button', { name: 'Cancel reply', exact: true }).click();
    else await page.getByRole('button', { name: 'Remove file: second.txt (2)', exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(page.locator('.push-file-compose strong')).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send'));
    expect(calls).toHaveLength(1); expect(calls[0].extra.type).toBe(first === 'reply' ? 'Composite' : 'Reply');
  });
}
test('keeps every file and caption after an uncertain combined send with no automatic retry', async ({ page }) => {
  await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(['first', 'second'].map(name => ({ name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from(name) })));
  await expect(page.locator('.push-file-compose strong')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Kept combined caption');
  await page.evaluate(() => { (window as any).__pushFixture.failSend = true; });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Refresh history or membership before retrying');
  await expect(page.locator('.push-file-compose strong')).toHaveText(['first.txt', 'second.txt']);
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveValue('Kept combined caption');
  expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send').length)).toBe(1);
});
for (const change of ['source', 'wallet', 'permission']) {
  test(`discards a whole batch during its second file read after a ${change} change`, async ({ page }) => {
    await openRoom(page); await enable(page); await expect(page.getByText('Preserved Push history', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        if (this.name !== 'second.txt') return original.call(this);
        return new Promise<ArrayBuffer>((resolve, reject) => { (window as any).__releaseBatch = () => original.call(this).then(resolve, reject); });
      };
    });
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(['first', 'second', 'third'].map(name => ({ name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from(name) })));
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseBatch)).toBe('function');
    await expect(page.locator('.push-file-compose strong')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    if (change === 'source') await page.getByLabel('Include existing rooms').selectOption('research');
    if (change === 'wallet') await page.evaluate(other => { const s = (window as any).__pushFixture; s.address = other; s.emit('accountsChanged', [other]); }, other);
    if (change === 'permission') {
      await page.evaluate(() => { (window as any).__pushFixture.permissions.chat = false; });
      await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveCount(0);
    }
    await page.evaluate(() => (window as any).__releaseBatch());
    await expect(page.locator('.push-file-compose')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pushFixture.calls.filter((call: any) => call.kind === 'send'))).toEqual([]);
  });
}
