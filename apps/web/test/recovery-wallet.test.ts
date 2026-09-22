// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToString } from 'viem';
import { verifyRecoveryWallet } from '../src/recoveryWallet';
const mocks = vi.hoisted(() => ({ provider: null as any, verify: vi.fn(), create: vi.fn() }));
vi.mock('../src/walletProviders', () => ({ getActiveProvider: () => mocks.provider }));
vi.mock('viem', async importOriginal => ({ ...await importOriginal<any>(), createPublicClient: (...args: unknown[]) => {
  mocks.create(...args); return { verifyMessage: mocks.verify };
} }));
const owner = privateKeyToAccount(generatePrivateKey());
let listeners: Map<string, Function>;
let sign: (message: `0x${string}`) => Promise<string>;
let account: string;
let chain: string;
let signed: string[];
beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'https://chat.bittrees.org' } });
  listeners = new Map(); account = owner.address; chain = '0x1'; signed = [];
  sign = message => owner.signMessage({ message: { raw: message } });
  mocks.provider = {
    on: (event: string, cb: Function) => listeners.set(event, cb),
    removeListener: (event: string) => listeners.delete(event),
    request: vi.fn(async ({ method, params }: any) => {
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return chain;
      if (method === 'personal_sign') { signed.push(hexToString(params[0])); return sign(params[0]); }
      throw new Error('Unexpected provider method');
    }),
  };
  mocks.verify.mockReset().mockResolvedValue(false); mocks.create.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('proves EOA ownership locally with a fresh scoped challenge and releases listeners', async () => {
  const proof = await verifyRecoveryWallet(owner.address, () => {});
  expect(signed[0]).toContain('Chat local data export');
  expect(signed[0]).toContain('Origin: https://chat.bittrees.org');
  expect(signed[0]).toContain(owner.address.toLowerCase());
  expect(signed[0]).toMatch(/Nonce: 0x[0-9a-f]{32}/);
  expect(mocks.create).not.toHaveBeenCalled();
  await proof.assertCurrent(); proof.dispose(); expect(listeners.size).toBe(0);
  await expect(proof.assertCurrent()).rejects.toThrow();
  const second = await verifyRecoveryWallet(owner.address, () => {}); second.dispose();
  expect(signed[1]).not.toBe(signed[0]);
});
it('does not mistake the provider account list for ownership', async () => {
  const wrong = privateKeyToAccount(generatePrivateKey());
  sign = message => wrong.signMessage({ message: { raw: message } });
  await expect(verifyRecoveryWallet(owner.address, () => {})).rejects.toThrow('could not be verified');
  expect(listeners.size).toBe(0);
});
it('checks contract signatures through the mainnet verifier', async () => {
  sign = async () => '0x1234'; mocks.verify.mockResolvedValue(true);
  const proof = await verifyRecoveryWallet(owner.address, () => {}); proof.dispose();
  expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ address: owner.address.toLowerCase(), message: signed[0], signature: '0x1234' }));
});
it('fails closed for contract signatures on unsupported chains or unavailable RPC', async () => {
  sign = async () => '0x1234'; chain = '0xa';
  await expect(verifyRecoveryWallet(owner.address, () => {})).rejects.toThrow('mainnet');
  expect(mocks.verify).not.toHaveBeenCalled();
  chain = '0x1'; mocks.verify.mockRejectedValue(new Error('offline'));
  await expect(verifyRecoveryWallet(owner.address, () => {})).rejects.toThrow('offline');
  expect(listeners.size).toBe(0);
});
it.each(['accountsChanged', 'disconnect', 'session_delete'])('invalidates on %s even if the same account reconnects', async event => {
  sign = async message => { listeners.get(event)?.([owner.address]); return owner.signMessage({ message: { raw: message } }); };
  await expect(verifyRecoveryWallet(owner.address, () => {})).rejects.toThrow('changed or expired');
  expect(listeners.size).toBe(0);
});
it('rechecks accounts, chains, provider identity and expiration before file release', async () => {
  vi.useFakeTimers(); const proof = await verifyRecoveryWallet(owner.address, () => {});
  account = '0x' + 'cd'.repeat(20); await expect(proof.assertCurrent()).rejects.toThrow('wallet changed'); account = owner.address;
  chain = '0x2'; await expect(proof.assertCurrent()).rejects.toThrow('chain changed'); chain = '0x1';
  const provider = mocks.provider; mocks.provider = { ...provider }; await expect(proof.assertCurrent()).rejects.toThrow('changed or expired'); mocks.provider = provider;
  vi.advanceTimersByTime(120_000); await expect(proof.assertCurrent()).rejects.toThrow('changed or expired'); proof.dispose();
});
it('rejects expired signature prompts and cancelled component sessions without exporting', async () => {
  vi.useFakeTimers(); sign = async message => { vi.advanceTimersByTime(120_000); return owner.signMessage({ message: { raw: message } }); };
  await expect(verifyRecoveryWallet(owner.address, () => {})).rejects.toThrow('changed or expired');
  expect(listeners.size).toBe(0);
  await expect(verifyRecoveryWallet(owner.address, () => { throw new Error('Unmounted'); })).rejects.toThrow('Unmounted');
  expect(listeners.size).toBe(0);
});
it('rejects malformed signatures before invoking the contract verifier', async () => {
  sign = async () => 'not-a-signature';
  await expect(verifyRecoveryWallet(owner.address, () => {})).rejects.toThrow('Invalid ownership');
  expect(mocks.verify).not.toHaveBeenCalled(); expect(listeners.size).toBe(0);
});
it('times out a wallet that never answers instead of holding the export open forever', async () => {
  vi.useFakeTimers(); mocks.provider.request.mockImplementation(() => new Promise(() => {}));
  const operation = verifyRecoveryWallet(owner.address, () => {});
  const rejected = expect(operation).rejects.toThrow('changed or expired');
  await vi.advanceTimersByTimeAsync(120_000); await rejected;
  expect(listeners.size).toBe(0);
});

it('binds restore proof to its purpose and exposes a synchronous session guard for transactions', async () => {
  const proof = await verifyRecoveryWallet(owner.address, () => {}, 'restore');
  expect(signed[0]).toContain('Chat local data restore');
  expect(signed[0]).not.toContain('Chat local data export');
  proof.assertSession();
  listeners.get('accountsChanged')?.([owner.address]);
  expect(proof.assertSession).toThrow('changed or expired');
  proof.dispose();
});
