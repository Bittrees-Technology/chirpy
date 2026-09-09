import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { IdentityProvider, SettingsPrefsProvider, useIdentity, useSettingsPrefs } from '../src/state';
const mock = vi.hoisted(() => ({ account: '0x0000000000000000000000000000000000000001', handlers: new Map<string, Function>(), ens: vi.fn() }));
vi.mock('../src/ens', () => ({ resolveEns: (...args) => mock.ens(...args) }));
vi.mock('../src/walletProviders', () => {
  const provider = { request: async () => [mock.account], on: (event, cb) => mock.handlers.set(event, cb), removeListener: (event) => mock.handlers.delete(event) };
  return { getInjectedEthereum: () => provider, getActiveProvider: () => provider, getActiveKind: () => 'injected', setActiveProvider: () => {}, clearActiveProvider: () => {}, walletConnectAvailable: () => false, restoreWalletConnect: async () => null, connectWalletConnect: vi.fn() };
});
afterEach(() => vi.unstubAllGlobals());
it('isolates wallet preferences immediately and ignores late profile responses after switching/disconnecting', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const storage = new Map<string,string>();
  // This ambiguous global opt-in must not be inherited by a new wallet.
  storage.set('chat:settingsPrefs:v1', JSON.stringify({ readReceiptsDefault: true, syncAcrossDevices: true }));
  vi.stubGlobal('localStorage', { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) });
  const lookups: Array<{ address: string; resolve: (value: any) => void }> = [];
  mock.ens.mockImplementation((address) => new Promise((resolve) => lookups.push({ address, resolve })));
  let current: any;
  function Probe() { current = { ...useIdentity(), ...useSettingsPrefs() }; return null; }
  const root = createRoot(document.createElement('div'));
  const a = mock.account; const b = '0x0000000000000000000000000000000000000002';
  storage.set(`chat:settingsPrefs:v1:wallet:${b}`, JSON.stringify({ readReceiptsDefault: 'false', syncAcrossDevices: 'true', blocked: 'invalid' }));
  try {
    await act(async () => root.render(React.createElement(IdentityProvider, null, React.createElement(SettingsPrefsProvider, null, React.createElement(Probe)))));
    await act(async () => { void current.connectWallet(); await Promise.resolve(); });
    expect(current.identity.address).toBe(a);
    expect(current.prefs.readReceiptsDefault).toBe(false);
    expect(current.prefs.syncAcrossDevices).toBe(false);
    await act(async () => current.setReadReceiptsDefault(true));
    mock.account = b;
    let result: any;
    await act(async () => { result = await current.enableSyncAcrossDevices(); });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Wallet account changed');
    await act(async () => { mock.account = b; mock.handlers.get('accountsChanged')?.([b]); });
    expect(current.identity.address).toBe(b);
    expect(current.prefs.readReceiptsDefault).toBe(false);
    expect(current.prefs.syncAcrossDevices).toBe(false);
    expect(current.prefs.blocked).toEqual([]);
    await act(async () => lookups[0].resolve({ name: 'old.eth' }));
    expect(current.identity.address).toBe(b);
    expect(current.identity.handle).not.toBe('old.eth');
    await act(async () => { mock.account = a; mock.handlers.get('accountsChanged')?.([a]); });
    expect(current.prefs.readReceiptsDefault).toBe(true);
    await act(async () => current.disconnectWallet());
    await act(async () => { for (const lookup of lookups) lookup.resolve({ name: 'late.eth' }); });
    expect(current.mode).toBe('stub');
    expect(current.identity.handle).not.toBe('late.eth');
    expect(current.prefs.readReceiptsDefault).toBe(false);
    expect(JSON.parse(storage.get('chat:settingsPrefs:v1')!).readReceiptsDefault).toBe(true);
  } finally { await act(async () => root.unmount()); mock.account = a; mock.handlers.clear(); }
});
