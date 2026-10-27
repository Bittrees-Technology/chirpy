import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
const wallet = '0x' + 'ab'.repeat(20);
const other = '0x' + 'cd'.repeat(20);
beforeEach(() => {
  vi.resetModules();
  const storage = new Map([['chirpy.xmtp.ready.' + wallet, '1']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const { XmtpTransport } = await import('../src/xmtp');
  const provider = { request: vi.fn(async (_request: { method: string }) => [wallet]) };
  const transport = new XmtpTransport(PERSONAL_ORG, { address: wallet }, provider);
  const existing = { isRegistered: vi.fn(async () => true), close: vi.fn() };
  const created = { close: vi.fn() };
  const sdk = { IdentifierKind: { Ethereum: 0 }, LogLevel: { Off: 0 }, Client: {
    build: vi.fn(async () => existing), create: vi.fn(async () => created),
  } };
  Object.assign(transport, { loadSdk: async () => sdk, listConversations: vi.fn(async () => []) });
  return { transport, provider, existing, created, sdk };
}
it('reconnects a saved registered installation without registration or wallet signing', async () => {
  const f = await setup();
  await f.transport.enable();
  expect(f.sdk.Client.build).toHaveBeenCalledOnce();
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.provider.request.mock.calls.every(([args]) => (args as any).method === 'eth_accounts')).toBe(true);
  expect(f.provider.request).toHaveBeenCalledTimes(3);
  expect(f.existing.close).not.toHaveBeenCalled();
  expect(f.transport.status).toBe('ready');
});
it('retries saved installation after transient startup failure without creating another', async () => {
  const f = await setup(); f.sdk.Client.build.mockRejectedValueOnce(new Error('temporary offline'));
  await f.transport.init();
  expect(f.transport.status).toBe('idle');
  await f.transport.enable();
  expect(f.sdk.Client.build).toHaveBeenCalledTimes(2);
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.transport.status).toBe('ready');
});
it('holds an uncertain reconnect without registration, signing or revocation', async () => {
  const f = await setup(); f.sdk.Client.build.mockRejectedValue(new Error('temporary offline'));
  await expect(f.transport.enable()).rejects.toThrow('temporary offline');
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.transport.status).toBe('error');
});
it('only registers after confirming that the local installation is unregistered', async () => {
  const f = await setup(); f.existing.isRegistered.mockResolvedValue(false);
  await f.transport.enable();
  expect(f.existing.close).toHaveBeenCalledOnce();
  expect(f.sdk.Client.create).toHaveBeenCalledOnce();
  expect(f.transport.status).toBe('ready');
});
it.each(['before', 'after'])('rejects a wallet change %s saved-installation lookup', async phase => {
  const f = await setup();
  if (phase === 'before') f.provider.request.mockResolvedValue([other]);
  else f.existing.isRegistered.mockImplementationOnce(async () => {
    f.provider.request.mockResolvedValue([other]); return true;
  });
  await expect(f.transport.enable()).rejects.toThrow('Wallet changed');
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  if (phase === 'before') expect(f.sdk.Client.build).not.toHaveBeenCalled();
  else expect(f.existing.close).toHaveBeenCalledOnce();
  expect(f.transport.status).toBe('error');
});
it('closes a candidate and holds an uncertain registration-state response', async () => {
  const f = await setup(); f.existing.isRegistered.mockRejectedValueOnce(new Error('lookup unavailable'));
  await expect(f.transport.enable()).rejects.toThrow('lookup unavailable');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
it('preserves explicit installation-revocation recovery instead of reopening the old client', async () => {
  const f = await setup(); const revoke = vi.fn(async () => 1);
  Object.assign(f.transport, { revokeStaleInstallations: revoke });
  await f.transport.enable({ revokeStale: true });
  expect(revoke).toHaveBeenCalledOnce(); expect(f.sdk.Client.build).not.toHaveBeenCalled();
  expect(f.sdk.Client.create).toHaveBeenCalledOnce();
});
it('keeps first-time enablement explicit when no saved installation was enabled', async () => {
  const f = await setup(); localStorage.removeItem('chirpy.xmtp.ready.' + wallet);
  await f.transport.init(); expect(f.sdk.Client.build).not.toHaveBeenCalled();
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  await f.transport.enable(); expect(f.sdk.Client.create).toHaveBeenCalledOnce();
});

it('does not retain a client when the wallet changes during inbox loading', async () => {
  const f = await setup();
  Object.assign(f.transport, { listConversations: vi.fn(async () => {
    f.provider.request.mockResolvedValue([other]); return [];
  }) });
  await expect(f.transport.enable()).rejects.toThrow('Wallet changed');
  expect(f.existing.close).toHaveBeenCalledOnce();
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect((f.transport as any).client).toBeNull();
});
it('holds malformed registration status instead of treating it as a missing installation', async () => {
  const f = await setup(); f.existing.isRegistered.mockResolvedValue(undefined as any);
  await expect(f.transport.enable()).rejects.toThrow('Unable to confirm');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
it('releases a failed saved client without replacing its identity or signing', async () => {
  const f = await setup(); Object.assign(f.transport, { listConversations: vi.fn(async () => { throw new Error('inbox unavailable'); }) });
  await expect(f.transport.enable()).rejects.toThrow('inbox unavailable');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect((f.transport as any).client).toBeNull(); expect(f.transport.status).toBe('error');
});

it('does not report success if inbox loading invalidates the saved installation', async () => {
  const f = await setup();
  Object.assign(f.transport, { listConversations: vi.fn(async () => {
    Object.assign(f.transport, { client: null, status: 'idle' }); return [];
  }) });
  await expect(f.transport.enable()).rejects.toThrow('saved messaging installation is unavailable');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.transport.status).toBe('error');
});
