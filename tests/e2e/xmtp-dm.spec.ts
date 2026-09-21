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
    const walletA = await injectSyntheticWallet(contextA, keyA);
    const walletB = await injectSyntheticWallet(contextB);
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
      // A separate browser context has no XMTP database or application storage.
      // Keep the old installation online; the same wallet alone is not recovery proof.
      const freshContext = await browser.newContext();
      try {
        await injectSyntheticWallet(freshContext, keyA);
        const freshPage = await freshContext.newPage();
        await enableMessaging(freshPage, walletA);
        await freshPage.locator('.nav-item', { hasText: 'Settings' }).click();
        await freshPage.getByRole('button', { name: 'Request message history', exact: true }).click();
        await expect(freshPage.getByRole('status').filter({ hasText: 'History requested.' })).toBeVisible();
        await freshPage.locator('.nav-item', { hasText: 'Chats' }).click({ timeout: 30_000 });
        await openConversationWithMessage(freshPage, 'receipt acceptance message');
        await expect(freshPage.locator('.msg-body', { hasText: 'hello from A' })).toBeVisible({ timeout: 120_000 });
        await expect(freshPage.locator('.msg-body', { hasText: 'hi from B' })).toBeVisible({ timeout: 120_000 });
        // The imported accepted consent makes the recovered DM usable without accepting again.
        await expect(freshPage.locator('.composer-input')).toBeVisible();
      } finally { await freshContext.close(); }
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
