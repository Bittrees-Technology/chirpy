import { test, expect } from '@playwright/test';
test('real browser SDK imports, crypto and signer compatibility without external traffic or persistent keys', async ({ page, baseURL }) => {
  const external: string[] = []; let registryRequests = 0; let secretRequests = 0; const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.href === 'https://backend.epns.io/apis/v1/chat/encryptedsecret/sessionKey/synthetic-session-key' && route.request().method() === 'GET') {
      secretRequests++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ encryptedSecret: await page.evaluate(() => (window as any).mockEncryptedSecret) }) });
    }
    if (url.origin === 'https://backend.epns.io' && url.pathname === '/apis/v2/users/' && route.request().method() === 'GET') {
      registryRequests++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => (window as any).mockPushUser)) });
    }
    if (new URL(route.request().url()).origin === new URL(baseURL!).origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.goto('/'); await expect(page.locator('body')).toHaveText('Push runtime ready');
  const result = await page.evaluate(() => (window as any).runPushCompatibility());
  expect(result).toMatchObject({ sdkLoaded: true, isolatedRoomKeys: true, realRuntimeReady: true, withoutInjectedReady: true, withoutInjectedPublicKey: true, legacyRecoveryBound: true, decrypted: 'Synthetic room message', tamperedRejected: true, staleRejected: true, personalSigned: true, typedSigned: true, storageUnchanged: true });
  expect(registryRequests).toBe(2); expect(secretRequests).toBe(2);
  expect(result.uuid).toMatch(/^[0-9a-f-]{36}$/); expect(external).toEqual([]); expect(errors).toEqual([]);
});
