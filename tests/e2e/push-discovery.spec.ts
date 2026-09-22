import { test, expect } from '@playwright/test';
for (const mobile of [false, true]) {
  test(`Push catalog discovery preserves source boundaries without connecting a wallet (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    // Reproduce the shared service's fixed control without relying on its network availability.
    await page.route('https://insights.bittrees.org/consent.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      const style = document.createElement('style');
      style.textContent = '.bt-insights-preferences{position:fixed;bottom:12px;left:16px;z-index:2147482999;padding:6px 10px;font:12px/1.4 system-ui}';
      document.head.appendChild(style);
      const button = document.createElement('button'); button.className = 'bt-insights-preferences';
      button.textContent = 'Analytics preferences'; document.body.appendChild(button);
    ` }));
    let sdkRequests = 0;
    await page.route('https://*.push.org/**', async route => { sdkRequests++; await route.abort(); });
    await page.route('https://gov.bittrees.org/api/rooms', route => route.fulfill({ json: { rooms: { shareholders: 'a'.repeat(64) }, custom: [], revision: 1 } }));
    await page.route('https://research.bittrees.org/api/rooms', route => route.fulfill({ json: { rooms: {}, custom: [], revision: 0 } }));
    await page.goto('/');
    const decline = page.getByRole('button', { name: 'Decline', exact: true });
    if (await decline.isVisible()) await decline.click();
    if (mobile) {
      const navigation = page.getByRole('navigation', { name: 'Primary' });
      const control = page.getByRole('button', { name: 'Analytics preferences', exact: true });
      await expect(control).toBeVisible();
      const navBounds = await navigation.boundingBox(); const controlBounds = await control.boundingBox();
      expect(controlBounds!.y).toBeGreaterThanOrEqual(navBounds!.y + navBounds!.height);
      await navigation.getByRole('button', { name: 'Rooms' }).click();
    }
    else await page.locator('.nav-item', { hasText: 'Rooms' }).click();
    await page.getByLabel('Include existing rooms').selectOption('governance');
    const room = page.locator('.list-item', { hasText: /shareholders/i });
    await expect(room).toBeVisible(); await room.click();
    await expect(page.locator('.thread-sub')).toContainText('Governance · Push · Visibility not checked · Membership not checked');
    await expect(page.locator('.composer-input')).toHaveCount(0);
    await expect(page.locator('.thread').getByRole('button', { name: 'Connect Push rooms' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('push-room.png') });
    if (mobile) await page.getByRole('button', { name: 'Back to chats' }).click();
    await page.getByLabel('Include existing rooms').selectOption('research');
    await expect(page.locator('.list-item', { hasText: /shareholders/i })).toHaveCount(0);
    await expect(page.locator('.thread-title')).toHaveCount(0);
    expect(sdkRequests).toBe(0);
  });
}
