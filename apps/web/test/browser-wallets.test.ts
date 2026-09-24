import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { discoverBrowserWallets } from '../src/browserWallets';
import { clearActiveProvider, getActiveProvider, getActiveKind } from '../src/walletProviders';
import { IdentityProvider, useIdentity } from '../src/state';

vi.mock('../src/ens', () => ({ resolveEns: async () => null }));
const remote = vi.hoisted(() => ({ enabled: false, connect: vi.fn(), restore: vi.fn() }));
vi.mock('../src/walletProviders', async original => ({
  ...await original<typeof import('../src/walletProviders')>(),
  walletConnectAvailable: () => remote.enabled,
  connectWalletConnect: (...args: unknown[]) => remote.connect(...args),
  restoreWalletConnect: (...args: unknown[]) => remote.restore(...args),
}));
const a = '0x000000000000000000000000000000000000000a';
const b = '0x000000000000000000000000000000000000000b';
const uuidA = '00000000-0000-4000-8000-000000000001';
const uuidB = '00000000-0000-4000-8000-000000000002';
const savedKey = 'chat:browserWallet:v1';
const cleaners: Array<() => void> = [];

function wallet(address = a) {
  const handlers = new Map<string, Set<Function>>();
  return {
    request: vi.fn(async (_request: { method: string }): Promise<unknown> => [address]),
    on(event: string, callback: Function) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event)!.add(callback); },
    removeListener(event: string, callback: Function) { handlers.get(event)?.delete(callback); },
    emit(event: string, value?: unknown) { handlers.get(event)?.forEach(callback => callback(value)); },
    listenerCount() { return [...handlers.values()].reduce((sum, handlers) => sum + handlers.size, 0); },
  };
}
function announce(provider: ReturnType<typeof wallet>, uuid = uuidA, rdns = 'org.bittrees.wallet', name = 'Wallet') {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid, rdns, name }, provider } }));
}
function installed(provider: ReturnType<typeof wallet>, uuid = uuidA, rdns = 'org.bittrees.wallet') {
  const respond = () => announce(provider, uuid, rdns);
  window.addEventListener('eip6963:requestProvider', respond);
  cleaners.push(() => window.removeEventListener('eip6963:requestProvider', respond));
}
async function mount() {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let current: ReturnType<typeof useIdentity>;
  const root = createRoot(document.createElement('div'));
  function Probe() { current = useIdentity(); return null; }
  await act(async () => root.render(React.createElement(IdentityProvider, null, React.createElement(Probe))));
  return { get current() { return current!; }, close: () => act(async () => root.unmount()) };
}
beforeEach(() => {
  remote.enabled = false; remote.connect.mockReset(); remote.restore.mockReset();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key), clear: () => storage.clear() });
});
afterEach(() => {
  cleaners.splice(0).forEach(clean => clean());
  delete (window as any).ethereum;
  localStorage.clear();
  clearActiveProvider();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('discovers late providers, deduplicates by UUID and object, and retains a distinct legacy fallback', () => {
  const first = wallet(); const second = wallet(b);
  (window as any).ethereum = first;
  const discovery = discoverBrowserWallets();
  try {
    expect(discovery.snapshot()).toHaveLength(1);
    announce(first); announce(first, uuidB); announce(second); // Conflicting UUID cannot replace first.
    expect(discovery.snapshot()).toHaveLength(1);
    expect(discovery.snapshot()[0].provider).toBe(first);
    announce(second, uuidB, 'io.other.wallet');
    expect(discovery.snapshot()).toHaveLength(2);
    expect(first.request).not.toHaveBeenCalled();
    expect(second.request).not.toHaveBeenCalled();
  } finally { discovery.destroy(); }
});

it('rejects malformed and control-character metadata, bounds discovery, and never reads an icon', () => {
  const discovery = discoverBrowserWallets();
  try {
    announce(wallet(), 'bad'); announce(wallet(), uuidA, 'bad rdns'); announce(wallet(), uuidA, 'org.wallet', 'spoof\u202e');
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { get info() { throw Error('extension'); } } }));
    expect(discovery.snapshot()).toHaveLength(0);
    const info = { uuid: uuidA, name: 'Wallet', rdns: 'org.wallet', get icon() { throw Error('must not render'); } };
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider: wallet() } }));
    for (let n = 2; n < 60; n++) announce(wallet(), `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`);
    expect(discovery.snapshot()).toHaveLength(32);
  } finally { discovery.destroy(); }
});

it('requires selection with multiple wallets and follows only the selected provider, including disconnect', async () => {
  const first = wallet(); const second = wallet(b);
  (window as any).ethereum = first; installed(first); installed(second, uuidB, 'io.other.wallet');
  const f = await mount();
  try {
    await act(async () => f.current.connectWallet());
    expect(f.current.walletError).toContain('Choose');
    expect(first.request).not.toHaveBeenCalled(); expect(second.request).not.toHaveBeenCalled();
    await act(async () => first.emit('accountsChanged', [a]));
    expect(f.current.mode).toBe('stub');
    await act(async () => f.current.connectWallet(uuidB));
    expect(f.current.identity.address).toBe(b); expect(getActiveProvider()).toBe(second);
    await act(async () => first.emit('accountsChanged', [a]));
    expect(f.current.identity.address).toBe(b);
    await act(async () => second.emit('accountsChanged', [a]));
    expect(f.current.identity.address).toBe(a);
    expect(JSON.parse(localStorage.getItem(savedKey)!).address).toBe(a);
    await act(async () => f.current.disconnectWallet());
    await act(async () => second.emit('accountsChanged', [b]));
    expect(f.current.mode).toBe('stub'); expect(getActiveKind()).toBeNull();
    expect(second.listenerCount()).toBe(0);
  } finally { await f.close(); }
});

it('restores a selected extension across changing UUIDs without consulting the global provider', async () => {
  const first = wallet(); const second = wallet(b);
  (window as any).ethereum = first; installed(second, uuidB);
  localStorage.setItem('chat:walletConnected:v1', 'true');
  localStorage.setItem('chat:walletProviderKind:v1', '"injected"');
  localStorage.setItem(savedKey, JSON.stringify({ rdns: 'org.bittrees.wallet', address: b }));
  const f = await mount();
  try {
    expect(f.current.identity.address).toBe(b); expect(getActiveProvider()).toBe(second);
    expect(second.request).toHaveBeenCalledExactlyOnceWith({ method: 'eth_accounts' });
    expect(first.request).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each(['absent', 'ambiguous', 'different account'])('does not restore a selected wallet when it is %s', async kind => {
  const first = wallet(); const second = wallet(b);
  (window as any).ethereum = first;
  if (kind !== 'absent') installed(first);
  if (kind === 'ambiguous') installed(second, uuidB);
  localStorage.setItem('chat:walletConnected:v1', 'true');
  localStorage.setItem(savedKey, JSON.stringify({ rdns: 'org.bittrees.wallet', address: b }));
  const f = await mount();
  try {
    expect(f.current.mode).toBe('stub'); expect(getActiveKind()).toBeNull();
    expect(first.request.mock.calls.every(([request]) => request.method === 'eth_accounts')).toBe(true);
  } finally { await f.close(); }
});

it('ignores an old restore after a user selects another wallet and a pending approval after disconnect', async () => {
  const first = wallet(); const second = wallet(b);
  let restore!: (value: unknown) => void;
  first.request.mockImplementation(() => new Promise(resolve => { restore = resolve; }));
  (window as any).ethereum = first; installed(first); installed(second, uuidB, 'io.other.wallet');
  localStorage.setItem('chat:walletConnected:v1', 'true');
  const f = await mount();
  try {
    await act(async () => f.current.connectWallet(uuidB));
    await act(async () => restore([a]));
    expect(f.current.identity.address).toBe(b); expect(getActiveProvider()).toBe(second);
    await act(async () => f.current.disconnectWallet());
    let approve!: (value: unknown) => void;
    second.request.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    await act(async () => { void f.current.connectWallet(uuidB); });
    await act(async () => f.current.disconnectWallet());
    await act(async () => approve([b]));
    expect(f.current.mode).toBe('stub'); expect(getActiveKind()).toBeNull();
    expect(localStorage.getItem(savedKey)).toBeNull();
  } finally { await f.close(); }
});

it.each(['restore', 'connect'] as const)('ignores a delayed WalletConnect %s after the browser wallet is selected', async operation => {
  const browser = wallet(); const mobile = wallet(b);
  installed(browser);
  remote.enabled = true;
  let finish!: (value: unknown) => void;
  remote[operation].mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  if (operation === 'restore') {
    localStorage.setItem('chat:walletConnected:v1', 'true');
    localStorage.setItem('chat:walletProviderKind:v1', '"walletconnect"');
  }
  const f = await mount();
  try {
    if (operation === 'connect') await act(async () => { void f.current.connectWalletConnect(); });
    await act(async () => f.current.connectWallet(uuidA));
    await act(async () => finish({ provider: mobile, address: b }));
    expect(f.current.identity.address).toBe(a); expect(getActiveProvider()).toBe(browser);
    expect(getActiveKind()).toBe('injected'); expect(mobile.listenerCount()).toBe(0);
    expect(JSON.parse(localStorage.getItem(savedKey)!).rdns).toBe('org.bittrees.wallet');
  } finally { await f.close(); }
});

it('still connects WalletConnect and processes only its active events', async () => {
  const browser = wallet(); const mobile = wallet(b);
  (window as any).ethereum = browser; installed(browser);
  remote.enabled = true; remote.connect.mockResolvedValue({ provider: mobile, address: b });
  const f = await mount();
  try {
    await act(async () => f.current.connectWallet(uuidA));
    await act(async () => f.current.connectWalletConnect());
    expect(getActiveProvider()).toBe(mobile); expect(f.current.identity.address).toBe(b);
    expect(localStorage.getItem(savedKey)).toBeNull();
    await act(async () => browser.emit('accountsChanged', [a]));
    expect(f.current.identity.address).toBe(b);
    await act(async () => mobile.emit('disconnect'));
    expect(f.current.mode).toBe('stub'); expect(getActiveKind()).toBeNull();
  } finally { await f.close(); }
});
