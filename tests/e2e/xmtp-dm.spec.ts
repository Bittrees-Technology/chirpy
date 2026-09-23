import type { Page } from "@playwright/test";
import { generatePrivateKey } from 'viem/accounts';
import { expect, injectSyntheticWallet, test } from "./fixtures/wallet";

test.describe("XMTP two-wallet direct messages @xmtp", () => {
  test.describe.configure({ retries: process.env.CI ? 2 : 0, timeout: 480_000 });

  test("two synthetic wallets exchange DMs and recover history on a fresh installation", async ({ browser }) => {
    test.skip(process.env.XMTP_E2E !== "1", "XMTP E2E is nightly/opt-in only.");

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const keyA = generatePrivateKey();
    const keyB = generatePrivateKey();
    const walletA = await injectSyntheticWallet(contextA, keyA);
    const walletB = await injectSyntheticWallet(contextB, keyB);
    const labels = new Map([[walletA.toLowerCase(), "Group creator"], [walletB.toLowerCase(), "Group member"]]);
    for (const context of [contextA, contextB]) await groupProfiles(context, labels);
    // Count only action names at the real browser SDK worker boundary; never
    // retain message bodies, wallet signatures or worker request parameters.
    for (const context of [contextA, contextB]) await context.addInitScript(() => {
      const counts = (window as any).__xmtpReads = { targeted: 0, listed: 0 };
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (...args: any[]) {
        if (args[0]?.action === 'conversations.getConversationById') counts.targeted++;
        if (args[0]?.action === 'conversations.list') counts.listed++;
        return (post as any).apply(this, args);
      };
    });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await enableMessaging(pageA, walletA);
      await enableMessaging(pageB, walletB);

      await startDm(pageA, walletB, "wallet B");
      await sendMessage(pageA, "hello from A");

      await pageB.getByRole("button", { name: "Requests", exact: true }).click();
      await expect(pageB.locator(".list-item", { hasText: "hello from A" }).locator(".badge")).toHaveText("1", { timeout: 120_000 });
      await openConversationWithMessage(pageB, "hello from A");
      await expect(pageB.locator(".msg-body", { hasText: "hello from A" })).toBeVisible({ timeout: 120_000 });

      await expect(pageB.locator(".composer-input")).toHaveCount(0);
      await pageB.getByRole("button", { name: "Accept request", exact: true }).click();
      await sendMessage(pageB, "hi from B");
      await expect(pageA.locator(".msg-body", { hasText: "hi from B" })).toBeVisible({ timeout: 120_000 });

      await expect(pageA.getByTestId("peer-receipt")).toHaveCount(0);
      await pageB.bringToFront();
      await pageB.getByRole("combobox", { name: "Send read receipts" }).selectOption("true");
      // Opting in does not retroactively acknowledge already-read messages.
      await pageA.bringToFront();
      await sendMessage(pageA, "receipt acceptance message");
      await pageB.bringToFront();
      await expect(pageB.locator(".msg-body", { hasText: "receipt acceptance message" })).toBeVisible({ timeout: 120_000 });
      await pageA.bringToFront();
      await expect(pageA.getByTestId("peer-receipt")).toContainText("Last read receipt", { timeout: 120_000 });
      await expect(pageA.locator(".list-item", { hasText: "receipt acceptance message" })).toBeVisible();
      await expect.poll(() => pageA.evaluate(() => (window as any).__xmtpReads.targeted)).toBeGreaterThan(0);
      await expect.poll(() => pageB.evaluate(() => (window as any).__xmtpReads.targeted)).toBeGreaterThan(0);
      await pageA.locator('.nav-item', { hasText: 'Rooms' }).click();
      await pageA.getByRole('button', { name: '+ Room', exact: true }).click();
      await pageA.getByLabel('Room name').fill('dev acceptance room');
      await pageA.getByRole('button', { name: 'Create room', exact: true }).click();
      await expect(pageA.locator('.thread-title')).toContainText('dev acceptance room', { timeout: 120_000 });
      await pageA.locator('.room-members summary').click();
      await pageA.getByLabel('Member wallet', { exact: true }).fill(walletB);
      await pageA.getByRole('button', { name: 'Add member', exact: true }).click();
      await expect(pageA.getByRole('status').filter({ hasText: 'Member added.' })).toBeVisible({ timeout: 120_000 });
      await expect(pageA.getByRole('list', { name: 'Room members' }).getByText(walletB.toLowerCase(), { exact: true })).toBeVisible();
      await pageA.locator('.room-members summary').click();
      await sendMessage(pageA, 'group message after adding B');
      await pageB.locator('.nav-item', { hasText: 'Rooms' }).click();
      await openConversationWithMessage(pageB, 'group message after adding B');
      await expect(pageB.locator('.msg-body', { hasText: 'group message after adding B' })).toBeVisible({ timeout: 120_000 });
      await expect(pageB.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
      await sendMessage(pageB, 'group reply from B');
      await expect(pageA.locator('.msg-body', { hasText: 'group reply from B' })).toBeVisible({ timeout: 120_000 });
      await expect(pageA.locator('.msg-row', { has: pageA.locator('.msg-body', { hasText: 'group reply from B' }) }).locator('.profile-wallet')).toHaveAttribute('title', walletB.toLowerCase());
      await expect(pageA.locator('.msg-row', { has: pageA.locator('.msg-body', { hasText: 'group reply from B' }) }).locator('.profile-wallet')).toContainText('Group member');
      await expect(pageB.locator('.msg-row', { has: pageB.locator('.msg-body', { hasText: 'group message after adding B' }) }).locator('.profile-wallet')).toHaveAttribute('title', walletA.toLowerCase());
      const replyRow = pageA.locator('.msg-row', { has: pageA.locator('.msg-body', { hasText: 'group reply from B' }) });
      await replyRow.getByRole('button', { name: 'React with 👍', exact: true }).click();
      await expect(replyRow.locator('.reaction-chip')).toContainText('👍 1', { timeout: 120_000 });
      await expect(pageB.locator('.msg-row', { has: pageB.locator('.msg-body', { hasText: 'group reply from B' }) }).locator('.reaction-chip')).toContainText('👍 1', { timeout: 120_000 });
      labels.delete(walletB.toLowerCase());
      await pageA.evaluate(() => window.dispatchEvent(new Event('chat:public-profile-changed')));
      await expect(replyRow.locator('.profile-wallet')).not.toContainText('Group member');
      await expect(replyRow.locator('.profile-wallet')).toHaveAttribute('title', walletB.toLowerCase());
      labels.set(walletB.toLowerCase(), 'Group member');


      // A separate browser context has no XMTP database or application storage.
      // Keep the old installation online; the same wallet alone is not recovery proof.
      for (const [key, wallet, other, label] of [[keyA, walletA, walletB, "Group member"], [keyB, walletB, walletA, "Group creator"]] as const) {
      const freshContext = await browser.newContext();
      try {
        await injectSyntheticWallet(freshContext, key);
        await groupProfiles(freshContext, labels);
        const freshPage = await freshContext.newPage();
        await enableMessaging(freshPage, wallet);
        await freshPage.locator('.nav-item', { hasText: 'Settings' }).click();
        await freshPage.getByRole('button', { name: 'Request message history', exact: true }).click();
        await expect(freshPage.getByRole('status').filter({ hasText: 'History requested.' })).toBeVisible();
        await freshPage.locator('.nav-item', { hasText: 'Chats' }).click({ timeout: 30_000 });
        await openConversationWithMessage(freshPage, 'receipt acceptance message');
        await expect(freshPage.locator('.msg-body', { hasText: 'hello from A' })).toBeVisible({ timeout: 120_000 });
        await expect(freshPage.locator('.msg-body', { hasText: 'hi from B' })).toBeVisible({ timeout: 120_000 });
        // The imported accepted consent makes the recovered DM usable without accepting again.
        await expect(freshPage.locator('.composer-input')).toBeVisible();
        await freshPage.locator('.nav-item', { hasText: 'Rooms' }).click();
        await openConversationWithMessage(freshPage, 'group reply from B');
        await expect(freshPage.locator('.msg-body', { hasText: 'group message after adding B' })).toBeVisible({ timeout: 120_000 });
        await expect(freshPage.locator('.msg-body', { hasText: 'group reply from B' })).toBeVisible({ timeout: 120_000 });
        await freshPage.locator('.room-members summary').click();
        await expect(freshPage.getByRole('list', { name: 'Room members' }).getByText(other.toLowerCase(), { exact: true })).toBeVisible();
        if (wallet === walletA) await expect(freshPage.getByRole('button', { name: 'Add member', exact: true })).toBeDisabled();
        else await expect(freshPage.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
        const author = freshPage.locator('.profile-wallet').filter({ hasText: label });
        await expect(author.first()).toHaveAttribute('title', other.toLowerCase());

      } finally { await freshContext.close(); }
      }
      // Actual production gated-room acceptance still requires the configured gate and reviewed policy.

    } finally {
      await contextB.close();
      await contextA.close();
    }
  });
});

async function enableMessaging(page: Page, walletAddress: string) {
  await page.goto("/");
  await page.locator(".nav-item", { hasText: "Settings" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByRole("textbox", { name: "Address", exact: true })).toHaveValue(walletAddress, { timeout: 30_000 });
  await page.getByRole("button", { name: "Enable messaging" }).click();
  await expect(page.getByText("Messaging enabled on this device.")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await page.getByRole("button", { name: "Chats" }).click();
}

async function startDm(page: Page, peerAddress: string, displayName: string) {
  await page.getByRole("button", { name: "+ Chat" }).click();
  await page.getByLabel("Recipient").fill(peerAddress);
  await page.getByLabel("Display name (optional)").fill(displayName);
  await page.getByRole("button", { name: "Start chat" }).click();
  await expect(page.locator(".composer-input")).toBeVisible({ timeout: 120_000 });
}

async function sendMessage(page: Page, body: string) {
  await page.locator(".composer-input").fill(body);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-body", { hasText: body })).toBeVisible({ timeout: 120_000 });
}

async function openConversationWithMessage(page: Page, body: string) {
  const row = page.locator(".list-item", { hasText: body }).first();
  await expect(row).toBeVisible({ timeout: 120_000 });
  await row.click();
}

// Real XMTP identity/history; synthetic opt-in public labels avoid publishing profiles.
async function groupProfiles(context: import('@playwright/test').BrowserContext, labels: Map<string, string>) {
  await context.route('**/api/profile?wallet=*', route => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: { service: new URL('/api/profile', url).href,
      profiles: (url.searchParams.get('wallet') ?? '').split(',').map(wallet => ({ version: 1, wallet, revision: 1, label: labels.get(wallet) ?? null, updatedAt: Date.now() })) } });
  });
}
