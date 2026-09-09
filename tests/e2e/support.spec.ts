import { expect, test } from '@playwright/test';

for (const [slug, heading, href] of [
  ['support', 'Chirpy support', 'https://github.com/Bittrees-Technology/chirpy/issues/new?template=bug.yml'],
  ['security', 'Report a Chirpy vulnerability', 'https://github.com/Bittrees-Technology/chirpy/security/advisories/new'],
]) {
  test(`${slug} page exposes a usable reporting channel`, async ({ page }) => {
    await page.goto(`/${slug}.html`);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('a.button')).toHaveAttribute('href', href);
    await expect(page.getByRole('navigation', { name: 'Site' }).getByRole('link')).toHaveAttribute('href', '/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('navigation', { name: 'Site' }).getByRole('link')).toBeFocused();
    await expect(page.locator('body')).toContainText('private keys');
  });
}
