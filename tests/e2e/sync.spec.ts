import { expect, test } from './fixtures/wallet';
import { recoverMessageAddress, keccak256, stringToHex } from 'viem';
import { syncGrantMessage, syncWriteMessage, syncRevokeDeviceMessage, syncRevokeAllMessage } from '../../packages/core/src/syncAuth';

test('encrypted sync signs scoped device writes and exposes confirmed revocation', async ({ page, walletAddress }) => {
  let record: any = { blob: null, revision: 0, updatedAt: 0 };
  let epoch = 0; let revoked = false; let writes = 0;
  await page.route('**/api/usersync**', async (route) => {
    const request = route.request(); const service = new URL('/api/usersync', request.url()).href;
    if (request.method() === 'GET') return route.fulfill({ json: { ...record, epoch, authVersion: 2, service } });
    const body = request.postDataJSON();
    if (body.action === 'revoke-all') {
      expect((await recoverMessageAddress({ message: syncRevokeAllMessage(service, body.address, body.epoch, body.expiresAt), signature: body.signature })).toLowerCase()).toBe(walletAddress.toLowerCase());
      epoch++; return route.fulfill({ json: { ok: true, epoch } });
    }
    const grant = body.authorization;
    expect(grant.service).toBe(service);
    expect((await recoverMessageAddress({ message: syncGrantMessage(grant), signature: grant.signature })).toLowerCase()).toBe(walletAddress.toLowerCase());
    const message = body.action === 'write' ? syncWriteMessage(grant, body.expectedRevision, keccak256(stringToHex(body.blob))) : syncRevokeDeviceMessage(grant);
    expect((await recoverMessageAddress({ message, signature: body.signature })).toLowerCase()).toBe(grant.device);
    if (body.action === 'revoke-device') { revoked = true; return route.fulfill({ json: { ok: true } }); }
    expect(revoked).toBe(false);
    expect(body.expectedRevision).toBe(record.revision);
    const encrypted = JSON.parse(body.blob);
    expect(encrypted.algorithm).toBe('AES-GCM');
    expect(encrypted.settingsPrefs).toBeUndefined();
    record = { blob: body.blob, updatedAt: Date.now(), revision: record.revision + 1 }; writes++;
    return route.fulfill({ json: { ok: true, revision: record.revision } });
  });
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.getByText('Encrypted sync is enabled for this browser session, for up to 24 hours.')).toBeVisible();
  expect(writes).toBeGreaterThan(0);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('chirpy.sync.authSig.')))).toEqual([]);
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Sync is off and this device authorization was revoked.')).toBeVisible();
  expect(revoked).toBe(true);
  await page.getByRole('button', { name: 'Revoke all sync devices', exact: true }).click();
  await expect(page.getByText('All existing sync device authorizations were revoked. Your encrypted saved data is retained.')).toBeVisible();
  expect(epoch).toBe(1); expect(record.blob).not.toBeNull();
});
