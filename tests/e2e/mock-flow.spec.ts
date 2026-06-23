import { expect, test } from "./fixtures/wallet";

test("synthetic wallet drives mock DM, room, and read-only policy", async ({ page, walletAddress }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText("test.eth").first()).toBeVisible();
  await expect(page.getByText(walletAddress.slice(0, 6), { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Chats" }).click();
  await page.getByRole("button", { name: "+ Chat" }).click();
  await page.getByLabel("Address or ENS name").fill("0x000000000000000000000000000000000000dEaD");
  await page.getByLabel("Display name (optional)").fill("e2e peer");
  await page.getByRole("button", { name: "Start chat" }).click();
  await expect(page.locator(".thread-title", { hasText: "e2e peer" })).toBeVisible();

  await page.getByPlaceholder("Message e2e peer").fill("hello from playwright");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-body", { hasText: "hello from playwright" })).toBeVisible();
  await page.getByRole("button", { name: "👍" }).first().click();
  await expect(page.getByText("👍 1")).toBeVisible();

  await page.getByRole("button", { name: "+ Room" }).click();
  await page.getByLabel("Room name").fill("e2e-room");
  await page.getByLabel("Description (optional)").fill("mock browser policy test");
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.locator(".thread-title", { hasText: "# e2e-room" })).toBeVisible();

  await page.getByPlaceholder("Message #e2e-room").fill("room before freeze");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-body", { hasText: "room before freeze" })).toBeVisible();

  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await expect(page.getByText("This room is read-only. Posting is frozen.")).toBeVisible();
  await expect(page.getByPlaceholder("Message #e2e-room")).toHaveCount(0);
});
