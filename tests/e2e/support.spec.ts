import { expect, test } from '@playwright/test';

for (const [slug, heading, href] of [
  ['support', 'Chirpy support', 'https://github.com/Bittrees-Technology/chirpy/issues/new?template=bug.yml'],
  ['security', 'Report a Chirpy vulnerability', 'https://github.com/Bittrees-Technology/chirpy/security/advisories/new'],
]) {
  test(`${slug} page exposes a usable reporting channel`, async ({ page }) => {
    await page.goto(`/${slug}.html`);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('a.button')).toHaveAttribute('href', href);
    await expect(page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: '← Chirpy' })).toHaveAttribute('href', '/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: '← Chirpy' })).toBeFocused();
    await expect(page.locator('body')).toContainText('private keys');
  });
}

for (const [slug, heading, href] of [
  ['support', 'Ayuda de Chirpy', 'https://github.com/Bittrees-Technology/chirpy/issues/new?template=bug.yml'],
  ['security', 'Informar de una vulnerabilidad de Chirpy', 'https://github.com/Bittrees-Technology/chirpy/security/advisories/new'],
]) {
  test(`${slug} offers Spanish reporting instructions on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${slug}.html`);
    await page.getByRole('link', { name: 'Español', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/es/${slug}/$`));
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('a.button')).toHaveAttribute('href', href);
    await expect(page.getByRole('link', { name: 'English', exact: true })).toHaveAttribute('href', `/${slug}`);
    await expect(page.locator('body')).toContainText('claves privadas');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('navigation').getByRole('link', { name: '← Chirpy' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'English', exact: true })).toBeFocused();
    await page.screenshot({ path: `test-results/${slug}-spanish.png`, fullPage: true });
  });
}
