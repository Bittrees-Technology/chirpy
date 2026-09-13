import { expect, test } from "./fixtures/wallet";

test("email handoff stays separate from wallet messaging and the bridge is honest", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.locator(".nav-item", { hasText: "Channels" }).click();
  await expect(page.getByRole("heading", { name: "Email ↔ wallet: not connected yet" })).toBeVisible();
  await expect(page.getByText("Enable wallet messaging to create your invitation link.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("channels-mobile.png"), fullPage: true });
  expect(await page.locator(".settings").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "New message", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New message" });
  await dialog.getByLabel("Recipient", { exact: false }).fill("member+chat@example.com");
  await expect(dialog.getByRole("link", { name: "Open email app" })).toHaveAttribute("href", "mailto:member%2Bchat%40example.com");
  await expect(dialog.getByRole("button", { name: "Start chat" })).toHaveCount(0);
  await dialog.getByLabel("Recipient", { exact: false }).fill("a@example.com?subject=bad");
  await expect(dialog.getByRole("link")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Start chat" })).toBeDisabled();
});

test("wallet invitations require confirmation and open the selected chat", async ({ page, walletAddress }) => {
  expect(walletAddress).toMatch(/^0x/);
  const target = "0x000000000000000000000000000000000000dEaD";
  await page.goto(`/#to=${target}`);
  const dialog = page.getByRole("dialog", { name: "New message" });
  await expect(dialog.getByLabel("Recipient", { exact: false })).toHaveValue(target);
  await expect(page.locator(".thread-title")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start chat" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".thread-title")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Write a message" })).toHaveValue("");
});
