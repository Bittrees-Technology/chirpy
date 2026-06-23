import { expect, test } from "./fixtures/wallet";

test.describe("XMTP dev network @xmtp", () => {
  test.describe.configure({ retries: 2, timeout: 300_000 });

  test("synthetic wallet can enable messaging", async ({ page, walletAddress }) => {
    test.skip(process.env.XMTP_E2E !== "1", "XMTP smoke is nightly/opt-in only.");

    await page.goto("/");
    await page.locator(".nav-item", { hasText: "Settings" }).click();
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.getByRole("textbox", { name: "Address", exact: true })).toHaveValue(walletAddress);
    await page.getByRole("button", { name: "Enable messaging" }).click();

    await expect.poll(async () => {
      const banner = page.locator(".error-banner");
      return await banner.count();
    }, { timeout: 120_000 }).toBe(0);
  });
});
