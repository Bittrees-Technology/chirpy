import type { Page } from "@playwright/test";
import { expect, injectSyntheticWallet, test } from "./fixtures/wallet";

test.describe("XMTP two-wallet direct messages @xmtp", () => {
  test.describe.configure({ retries: 2, timeout: 480_000 });

  test("two synthetic wallets can exchange a DM round trip", async ({ browser }) => {
    test.skip(process.env.XMTP_E2E !== "1", "XMTP E2E is nightly/opt-in only.");

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const walletA = await injectSyntheticWallet(contextA);
    const walletB = await injectSyntheticWallet(contextB);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await enableMessaging(pageA, walletA);
      await enableMessaging(pageB, walletB);

      await startDm(pageA, walletB, "wallet B");
      await sendMessage(pageA, "hello from A");

      await openConversationWithMessage(pageB, "hello from A");
      await expect(pageB.locator(".msg-body", { hasText: "hello from A" })).toBeVisible({ timeout: 120_000 });

      await sendMessage(pageB, "hi from B");
      await expect(pageA.locator(".msg-body", { hasText: "hi from B" })).toBeVisible({ timeout: 120_000 });

      // TODO: add gated-room E2E once VITE_MAINNET_RPC_URL is available.
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
  await page.getByLabel("Address or ENS name").fill(peerAddress);
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
