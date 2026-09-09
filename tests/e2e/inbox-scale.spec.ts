import { expect, test } from '@playwright/test';

test('a 10,000-conversation inbox keeps rows and profile requests bounded while searching all chats', async ({ page }) => {
  let profileReads = 0;
  await page.route('https://api.ensideas.com/ens/resolve/**', async route => {
    profileReads++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.addInitScript(() => {
    if (localStorage.getItem('inbox-scale-seeded')) return;
    localStorage.setItem('inbox-scale-seeded', '1');
    const address = '0x0000000000000000000000000000000000000001';
    localStorage.setItem('chat:identity:v1', JSON.stringify({ address, handle: 'you' }));
    const conversations = Array.from({ length: 10_000 }, (_, index) => ({
      id: `dm-${index}`, kind: 'dm', title: `Peer ${String(index).padStart(5, '0')}`,
      peers: [address, `0x${(index + 2).toString(16).padStart(40, '0')}`], unread: 0,
    }));
    localStorage.setItem(`chat:mock:dms:${address}`, JSON.stringify({ conversations, messages: {} }));
  });
  await page.goto('/');
  const rows = page.locator('.list-scroll .list-item');
  const pages = page.getByRole('navigation', { name: 'Conversation pages' });
  await expect(rows).toHaveCount(50);
  await expect(pages.getByRole('status')).toHaveText('1–50 / 10000');
  await expect.poll(() => profileReads).toBe(50);
  await pages.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(rows.first()).toContainText('Peer 00050');
  await expect(rows).toHaveCount(50);
  await expect(pages.getByRole('status')).toHaveText('51–100 / 10000');
  await page.getByRole('textbox', { name: 'Search chats' }).fill('Peer 09999');
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(page.locator('.thread-title')).toHaveText('Peer 09999');
  await page.getByRole('textbox', { name: 'Search chats' }).fill('');
  await expect(rows).toHaveCount(50);
  await expect(pages.getByRole('status')).toHaveText('1–50 / 10000');
  await pages.getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('.nav-item', { hasText: 'Rooms' }).click();
  await page.locator('.nav-item', { hasText: 'Chats' }).click();
  await expect(rows.first()).toContainText('Peer 00000');
  await expect(pages.getByRole('status')).toHaveText('1–50 / 10000');
  expect(profileReads).toBeLessThanOrEqual(102);
});
