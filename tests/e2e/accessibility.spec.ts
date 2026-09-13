import { expect, test } from "./fixtures/wallet";

test("dialogs contain keyboard focus, close with Escape and return focus", async ({ page }) => {
  await page.goto("/");
  const opener = page.getByRole("button", { name: "+ Chat" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "New message" });
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

test("Mercado notification links require a click and never load private previews", async ({ page, context }) => {
  const url = "https://mercado.bittrees.org/account/notifications/synthetic-test";
  const requests: string[] = [];
  await context.route("https://mercado.bittrees.org/**", async route => {
    requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "Synthetic destination" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Saved Messages" }).first().click();
  const text = `Review in Mercado: ${url} <img src=x onerror=alert(1)> javascript:alert(2)`;
  await page.getByRole("textbox", { name: "Write a message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const message = page.locator(".msg-body").filter({ hasText: text });
  await expect(message).toHaveText(text);
  await expect(message.locator("img,script,iframe")).toHaveCount(0);
  const link = message.getByRole("link", { name: url, exact: true });
  await expect(link).toHaveAttribute("href", url);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(requests).toEqual([]);
  const opened = context.waitForEvent("page");
  await link.click();
  const destination = await opened;
  await destination.waitForLoadState();
  expect(requests).toEqual([url]);
  expect(await destination.evaluate(() => window.opener)).toBeNull();
  expect(await destination.evaluate(() => document.referrer)).toBe("");
});
