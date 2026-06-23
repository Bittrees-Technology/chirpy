import { expect, test } from "./fixtures/wallet";

test.describe("XMTP dev network @xmtp", () => {
  test.describe.configure({ retries: 2 });

  test("synthetic wallet can enable messaging", async ({ page }) => {
    test.skip(process.env.XMTP_E2E !== "1", "XMTP smoke is nightly/opt-in only.");

    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("button", { name: "Enable messaging" }).click();

    await expect.poll(async () => {
      const banner = page.locator(".error-banner");
      return await banner.count();
    }, { timeout: 120_000 }).toBe(0);
  });
});
