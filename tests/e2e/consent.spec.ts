import { expect, test } from '@playwright/test';
test('incoming request can be accepted, blocked and unblocked without leaking blocked history', async ({ page }) => {
  const address = '0x0000000000000000000000000000000000000001';
  await page.addInitScript(({ address }) => {
    if (localStorage.getItem('consent-test-seeded')) return;
    localStorage.setItem('consent-test-seeded', '1');
    localStorage.setItem('chat:identity:v1', JSON.stringify({ address, handle: 'you' }));
    const message = { id: 'message', conversationId: 'request', sender: '0x0000000000000000000000000000000000000002', body: 'incoming request content', sentAt: 1 };
    localStorage.setItem(`chat:mock:dms:${address}`, JSON.stringify({ conversations: [{ id: 'request', kind: 'dm', title: 'request peer', peers: [address, message.sender], pending: true, unread: 1, lastMessage: message }], messages: { request: [message] } }));
  }, { address });
  await page.goto('/');
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await page.getByRole('button', { name: /request peer/ }).click();
  await expect(page.getByRole('button', { name: 'Accept request', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Accept request', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toBeVisible();
  await page.getByRole('button', { name: 'Block conversation', exact: true }).click();
  await expect(page.locator('.msg-body')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Blocked', exact: true }).click();
  await page.getByRole('button', { name: /request peer/ }).click();
  await expect(page.locator('.msg-body')).toHaveCount(0);
  await page.getByRole('button', { name: 'Unblock conversation', exact: true }).click();
  await expect(page.locator('.msg-body', { hasText: 'incoming request content' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toBeVisible();
});
