import { afterEach, expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
const wallet = '0x' + 'ab'.repeat(20); const inbox = 'cd'.repeat(32); const device = 'ef'.repeat(32);
afterEach(() => vi.useRealTimers());
function setup() {
  const provider = { request: vi.fn(async (_args: { method: string }) => [wallet]) };
  const transport = new XmtpTransport(PERSONAL_ORG, { address: wallet }, provider);
  const state: any = { inboxId: inbox, accountIdentifiers: [{ identifier: wallet, identifierKind: 0 }],
    installations: [{ id: device, bytes: new Uint8Array(32).fill(239), clientTimestampNs: 1_790_000_000_000_000_000n, secret: 'NEVER_INCLUDE' }], recoveryIdentifier: 'NEVER_INCLUDE' };
  const sdk = { IdentifierKind: { Ethereum: 0 }, createBackend: vi.fn(async () => ({})),
    getInboxIdForIdentifier: vi.fn(async () => inbox as string | undefined), generateInboxId: vi.fn(),
    Client: { fetchInboxStates: vi.fn(async () => [state]), build: vi.fn(), create: vi.fn(), revokeInstallations: vi.fn() } };
  Object.assign(transport, { loadSdk: async () => sdk });
  return { transport, provider, state, sdk };
}
function noMutations(f: ReturnType<typeof setup>) {
  for (const fn of [f.sdk.Client.build, f.sdk.Client.create, f.sdk.Client.revokeInstallations, f.sdk.generateInboxId]) expect(fn).not.toHaveBeenCalled();
  expect(f.provider.request.mock.calls.every(([args]) => args.method === 'eth_accounts')).toBe(true);
}
it('reads only the bound wallet public metadata without creating clients, reading keys, signing or revoking', async () => {
  const f = setup(); Object.assign(f.transport, { client: { installationId: device, secret: 'NEVER_INCLUDE' } });
  expect(await f.transport.inspectMessagingDevices()).toEqual({ inboxId: inbox, localInstallationId: device,
    installations: [{ id: device, createdAtMs: 1_790_000_000_000 }] });
  noMutations(f); expect(f.transport.status).toBe('idle');
  expect(f.sdk.Client.fetchInboxStates).toHaveBeenCalledExactlyOnceWith([inbox], {});
});
it('does not invent a nonce-zero inbox when no network binding exists', async () => {
  const f = setup(); f.sdk.getInboxIdForIdentifier.mockResolvedValue(undefined);
  expect(await f.transport.inspectMessagingDevices()).toEqual({ inboxId: null, localInstallationId: null, installations: [] });
  expect(f.sdk.Client.fetchInboxStates).not.toHaveBeenCalled(); noMutations(f);
});
it.each([[], ['0x' + '00'.repeat(20)], [null], 'invalid'])('refuses wrong/disconnected wallets before network lookup: %j', async accounts => {
  const f = setup(); f.provider.request.mockResolvedValue(accounts as any);
  await expect(f.transport.inspectMessagingDevices()).rejects.toThrow('Wallet changed');
  expect(f.sdk.createBackend).not.toHaveBeenCalled(); noMutations(f);
});
it('does not fetch inbox state if the wallet changes during its binding lookup', async () => {
  const f = setup(); f.sdk.getInboxIdForIdentifier.mockImplementationOnce(async () => { f.provider.request.mockResolvedValue([]); return inbox; });
  await expect(f.transport.inspectMessagingDevices()).rejects.toThrow('Wallet changed');
  expect(f.sdk.Client.fetchInboxStates).not.toHaveBeenCalled(); noMutations(f);
});
it('discards a result if the wallet changes while reading devices', async () => {
  const f = setup(); f.sdk.Client.fetchInboxStates.mockImplementationOnce(async () => { f.provider.request.mockResolvedValue([]); return [f.state]; });
  await expect(f.transport.inspectMessagingDevices()).rejects.toThrow('Wallet changed'); noMutations(f);
});
it.each(['inbox', 'wallet', 'duplicate', 'id', 'size', 'timestamp', 'overflow', 'count'])('holds invalid or unbound metadata: %s', async problem => {
  const f = setup();
  if (problem === 'inbox') f.state.inboxId = 'aa'.repeat(32);
  if (problem === 'wallet') f.state.accountIdentifiers = [];
  if (problem === 'duplicate') f.state.installations.push(f.state.installations[0]);
  if (problem === 'id') f.state.installations[0].id = 'aa'.repeat(32);
  if (problem === 'size') f.state.installations[0].bytes = new Uint8Array(33);
  if (problem === 'timestamp') f.state.installations[0].clientTimestampNs = -1n;
  if (problem === 'overflow') f.state.installations[0].clientTimestampNs = 10n ** 40n;
  if (problem === 'count') f.state.installations = Array(33).fill(f.state.installations[0]);
  await expect(f.transport.inspectMessagingDevices()).rejects.toThrow(); noMutations(f);
});
it('reports unknown local identity and missing dates without claiming a device was lost or inactive', async () => {
  const f = setup(); delete f.state.installations[0].clientTimestampNs;
  expect(await f.transport.inspectMessagingDevices()).toEqual({ inboxId: inbox, localInstallationId: null, installations: [{ id: device, createdAtMs: null }] });
  noMutations(f);
});
it('bounds a stalled wallet read and does not start network lookup after its deadline', async () => {
  vi.useFakeTimers(); const f = setup(); let finish!: (v: string[]) => void;
  f.provider.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.transport.inspectMessagingDevices(); const rejected = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15_000); await rejected;
  finish([wallet]); await Promise.resolve(); await Promise.resolve();
  expect(f.sdk.createBackend).not.toHaveBeenCalled(); noMutations(f);
});

it('allows a shared wallet profile to read public metadata without reconnecting an extension', async () => {
  const f = setup(); Object.assign(f.transport, { provider: null });
  expect((await f.transport.inspectMessagingDevices()).installations).toHaveLength(1);
  expect(f.provider.request).not.toHaveBeenCalled(); noMutations(f);
});
