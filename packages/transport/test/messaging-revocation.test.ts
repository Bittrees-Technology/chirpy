import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';

const wallet = '0x' + 'ab'.repeat(20), other = '0x' + 'cd'.repeat(20);
const inbox = '12'.repeat(32), alternate = '34'.repeat(32);
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const { XmtpTransport } = await import('../src/xmtp');
  const accounts = { value: [wallet] };
  let onSign = () => {};
  const provider = { request: vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_accounts') return accounts.value;
    if (method === 'personal_sign') { onSign(); return '0x1234'; }
    throw Error('Unexpected wallet request');
  }) };
  const transport = new XmtpTransport(PERSONAL_ORG, { address: wallet }, provider);
  const backend = {};
  const state: any = { inboxId: inbox, accountIdentifiers: [{ identifier: wallet, identifierKind: 0 }],
    installations: [1, 2].map(byte => ({ id: byte.toString(16).padStart(2, '0').repeat(32), bytes: new Uint8Array(32).fill(byte) })) };
  const submitted = vi.fn();
  const sdk = { IdentifierKind: { Ethereum: 0 }, LogLevel: { Off: 0 },
    createBackend: vi.fn(async () => backend), getInboxIdForIdentifier: vi.fn(async () => inbox as string | undefined),
    generateInboxId: vi.fn(async () => alternate), Client: {
      fetchInboxStates: vi.fn(async () => [state]),
      revokeInstallations: vi.fn(async (signer: { signMessage: (text: string) => Promise<Uint8Array> }, ..._args: unknown[]) => {
        await signer.signMessage('Synthetic revocation request'); submitted();
      }),
      create: vi.fn(async () => ({ close: vi.fn() })), build: vi.fn(),
    } };
  Object.assign(transport, { loadSdk: async () => sdk, listConversations: vi.fn(async () => []) });
  return { transport, accounts, provider, backend, state, sdk, submitted, onSign: (fn: () => void) => { onSign = fn; } };
}

function noAuthorization(f: Awaited<ReturnType<typeof setup>>) {
  expect(f.sdk.generateInboxId).not.toHaveBeenCalled();
  expect(f.provider.request.mock.calls.some(([a]) => a.method === 'personal_sign')).toBe(false);
  expect(f.sdk.Client.revokeInstallations).not.toHaveBeenCalled();
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.submitted).not.toHaveBeenCalled();
}

it('only submits the verified network inbox and validated device IDs after wallet approval', async () => {
  const f = await setup();
  await f.transport.enable({ revokeStale: true });
  expect(f.sdk.generateInboxId).not.toHaveBeenCalled();
  expect(f.sdk.Client.revokeInstallations).toHaveBeenCalledOnce();
  expect(f.sdk.Client.revokeInstallations.mock.calls[0]?.slice(1, 3)).toEqual([inbox,
    [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)]]);
  expect(f.submitted).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).toHaveBeenCalledOnce();
});

it.each(['unavailable', 'missing'])('never derives a replacement inbox after a %s lookup', async reason => {
  const f = await setup();
  if (reason === 'unavailable') f.sdk.getInboxIdForIdentifier.mockRejectedValue(new Error('network unavailable'));
  else f.sdk.getInboxIdForIdentifier.mockResolvedValue(undefined);
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow();
  expect(f.sdk.Client.fetchInboxStates).not.toHaveBeenCalled(); noAuthorization(f);
});

it.each(['wallet', 'inbox', 'device', 'duplicate'])('refuses unbound or malformed %s metadata before signing', async problem => {
  const f = await setup();
  if (problem === 'wallet') f.state.accountIdentifiers = [{ identifier: other, identifierKind: 0 }];
  if (problem === 'inbox') f.state.inboxId = alternate;
  if (problem === 'device') f.state.installations[0].bytes = new Uint8Array(31);
  if (problem === 'duplicate') f.state.installations[1] = f.state.installations[0];
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow(); noAuthorization(f);
});

it('stops when the wallet changes while the device list loads', async () => {
  const f = await setup();
  f.sdk.Client.fetchInboxStates.mockImplementationOnce(async () => { f.accounts.value = [other]; return [f.state]; });
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow('Wallet changed'); noAuthorization(f);
});

it.each(['wallet', 'inbox'])('does not submit a signature or register when the %s changes during approval', async change => {
  const f = await setup();
  f.onSign(() => {
    if (change === 'wallet') f.accounts.value = [other];
    else f.sdk.getInboxIdForIdentifier.mockResolvedValue(alternate);
  });
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow();
  expect(f.sdk.generateInboxId).not.toHaveBeenCalled();
  expect(f.submitted).not.toHaveBeenCalled(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});

it('preserves a submitted revocation without registering after a later wallet change', async () => {
  const f = await setup();
  f.sdk.Client.revokeInstallations.mockImplementationOnce(async signer => {
    await signer.signMessage('Synthetic revocation request'); f.submitted(); f.accounts.value = [other];
  });
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow('Device recovery was submitted');
  expect(f.submitted).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
