import { expect, test } from "./fixtures/wallet";

test("synthetic wallet drives mock DM, room, and read-only policy", async ({ page, walletAddress }, testInfo) => {
  await page.goto("/");

  await page.locator(".nav-item", { hasText: "Settings" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText("test.eth").first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Address", exact: true })).toHaveValue(walletAddress);
  await expect(page.getByText(walletAddress.slice(0, 6), { exact: false }).first()).toBeVisible();

  await page.locator(".nav-item", { hasText: "Chats" }).click();
  await page.getByRole("button", { name: "+ Chat" }).click();
  await page.getByLabel("Recipient").fill("0x000000000000000000000000000000000000dEaD");
  await page.getByLabel("Display name (optional)").fill("e2e peer");
  await page.getByRole("button", { name: "Start chat" }).click();
  await expect(page.locator(".thread-title", { hasText: "e2e peer" })).toBeVisible();

  await page.getByPlaceholder("Message e2e peer").fill("hello from playwright");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-body", { hasText: "hello from playwright" })).toBeVisible();
  await page.getByRole("button", { name: "React with 👍" }).first().click();
  await expect(page.getByText("👍 1")).toBeVisible();

  if (await page.getByRole("button", { name: "+ Room" }).count() === 0) {
    await page.locator(".nav-item", { hasText: "Rooms" }).click();
  }
  await page.getByRole("button", { name: "+ Room" }).click();
  await page.getByLabel("Room name").fill("e2e-room");
  await page.getByLabel("Description (optional)").fill("mock browser policy test");
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.locator(".thread-title", { hasText: "# e2e-room" })).toBeVisible();

  await page.locator('.room-members summary').click();
  await page.getByLabel('Member wallet', { exact: true }).fill('0x000000000000000000000000000000000000dEaD');
  await page.setViewportSize({ width: 390, height: 667 });
  await page.getByLabel('Member wallet', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('room-members-mobile.png') });
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(page.getByRole('status', { exact: false }).filter({ hasText: 'Demo member added locally.' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Room members' }).getByText('0x000000000000000000000000000000000000dead', { exact: true })).toBeVisible();
  await page.getByLabel('Member wallet', { exact: true }).fill('0x000000000000000000000000000000000000dEaD');
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already a room member');
  await expect(page.getByLabel('Member wallet', { exact: true })).toHaveValue('0x000000000000000000000000000000000000dEaD');
  await page.locator('.room-members summary').click();
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByPlaceholder("Message #e2e-room").fill("room before freeze");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-body", { hasText: "room before freeze" })).toBeVisible();

  await page.getByRole("button", { name: "Pause member posting", exact: true }).click();
  await expect(page.getByText("Member posting is paused in Chat. Administrators can still post; other clients may ignore this policy.")).toBeVisible();
  await page.getByPlaceholder("Message #e2e-room").fill("admin announcement");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".msg-body", { hasText: "admin announcement" })).toBeVisible();
  await expect(page.getByRole("button", { name: "React with 👍" }).first()).toBeEnabled();
  // The local demo represents losing the role; production actions recheck XMTP authority.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(key => key.startsWith("chat:mock:rooms:"))) {
      const data = JSON.parse(localStorage.getItem(key)!);
      for (const room of data.conversations) if (room.title === "e2e-room") room.isAdmin = false;
      localStorage.setItem(key, JSON.stringify(data));
    }
  });
  await page.reload();
  await page.locator(".nav-item", { hasText: "Rooms" }).click();
  await page.locator(".list-item", { hasText: "e2e-room" }).click();
  await expect(page.getByRole("button", { name: "Resume member posting", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add member", exact: true })).toHaveCount(0);
  await expect(page.getByText("Member posting is paused in Chat. Other clients may still send messages.")).toBeVisible();
  await expect(page.getByPlaceholder("Message #e2e-room")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "React with 👍" }).first()).toBeDisabled();
});
