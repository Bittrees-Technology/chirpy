import { expect, test } from "./fixtures/wallet";

test("dialogs contain keyboard focus, close with Escape and return focus", async ({ page }) => {
  await page.goto("/");
  const opener = page.getByRole("button", { name: "+ Chat" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "New direct message" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("message content remains text and reply controls have accessible names", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Saved Messages" }).first().click();
  const composer = page.getByRole("textbox", { name: "Write a message" });
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  await composer.fill(payload);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const message = page.locator(".msg-body").filter({ hasText: payload });
  await expect(message).toHaveText(payload);
  await expect(message.locator("img, script")).toHaveCount(0);
  const row = message.locator("..", {}).locator("..", {});
  await expect(row.getByRole("button", { name: "Reply", exact: true })).toBeAttached();
  await page.getByRole("region", { name: "Message history" }).focus();
  await expect(page.getByRole("region", { name: "Message history" })).toBeFocused();
});
