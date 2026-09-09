import { expect, test } from './fixtures/wallet';

test('long history stays bounded, supports backward/forward navigation and returns to latest after sending', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Saved Messages' }).first()).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('chat:mock:dms:'))!;
    const data = JSON.parse(localStorage.getItem(key)!);
    const conversation = data.conversations.find(c => c.title === 'Saved Messages');
    const start = Date.now() - 10000;
    const messages = Array.from({ length: 2000 }, (_, i) => ({ id: `history-${i}`, conversationId: conversation.id,
      sender: conversation.peers[0], body: `History item ${i}`, sentAt: start + i }));
    Object.assign(messages.at(-1)!, { replyTo: "history-0" });
    data.messages[conversation.id] = messages; conversation.lastMessage = messages.at(-1);
    localStorage.setItem(key, JSON.stringify(data));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Saved Messages' }).first().click();
  await expect(page.locator('.msg-row')).toHaveCount(50);
  await expect(page.locator('.msg-body').first()).toHaveText('History item 1950');
  await expect(page.locator('.msg-reply-ref').last()).toHaveText('↩ History item 0');
  await page.getByRole('button', { name: 'Older messages', exact: true }).click();
  await expect(page.locator('.msg-row')).toHaveCount(50);
  await expect(page.locator('.msg-body').first()).toHaveText('History item 1900');
  await page.screenshot({ path: testInfo.outputPath('history-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('history-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Older messages', exact: true }).click();
  await expect(page.locator('.msg-body').first()).toHaveText('History item 1850');
  await page.getByRole('button', { name: 'Newer messages', exact: true }).click();
  await expect(page.locator('.msg-body').first()).toHaveText('History item 1900');
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Sent while reading history');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.msg-body').last()).toHaveText('Sent while reading history');
  await expect(page.locator('.msg-row')).toHaveCount(50);
  await expect(page.getByRole('button', { name: 'Newer messages', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Older messages', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Latest messages', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Latest messages', exact: true }).click();
  await expect(page.locator('.msg-body').last()).toHaveText('Sent while reading history');
});
