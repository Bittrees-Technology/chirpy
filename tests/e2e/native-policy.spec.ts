import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures/wallet';
const config = JSON.parse(readFileSync('apps/web/src-tauri/tauri.conf.json', 'utf8'));

test('native content policy permits chat and WASM but blocks injected scripts and eval', async ({ page }) => {
  await page.route('**/*', async route => {
    if (route.request().isNavigationRequest()) {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': config.app.security.csp } });
    } else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved Messages' }).first().click();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Message under the native policy');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.msg-body', { hasText: 'Message under the native policy' })).toBeVisible();
  await page.route('**/csp-probe.js', route => route.fulfill({ contentType: 'application/javascript', body: `
    (async () => {
      let evalBlocked = false;
      try { new Function('return 1')(); } catch { evalBlocked = true; }
      await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
      window.nativePolicyResult = { evalBlocked, wasm: true };
    })();
  ` }));
  await page.evaluate(() => {
    const inline = document.createElement('script'); inline.textContent = 'window.nativeInjectionExecuted = true'; document.head.appendChild(inline);
    const probe = document.createElement('script'); probe.src = '/csp-probe.js'; document.head.appendChild(probe);
  });
  // Execute the eval probe as a normal page script: DevTools evaluation can bypass CSP.
  await expect.poll(() => page.evaluate(() => (window as any).nativePolicyResult)).toEqual({ evalBlocked: true, wasm: true });
  expect(await page.evaluate(() => (window as any).nativeInjectionExecuted === true)).toBe(false);
});
