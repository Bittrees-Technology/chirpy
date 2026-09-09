import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { IdentityProvider, SettingsPrefsProvider, useIdentity, useSettingsPrefs } from "../src/state";

const mocks = vi.hoisted(() => ({
  address: "0x0000000000000000000000000000000000000001",
  pull: vi.fn(), push: vi.fn(), authorize: vi.fn(),
}));
vi.mock("../src/ens", () => ({ resolveEns: async () => null }));
vi.mock("../src/walletProviders", () => {
  const provider = {
    request: async ({ method }) => method === "personal_sign" ? "0x" + "11".repeat(65) : [mocks.address],
    on: () => {}, removeListener: () => {},
  };
  return { getInjectedEthereum: () => provider, getActiveProvider: () => provider, getActiveKind: () => "injected", setActiveProvider: () => {}, clearActiveProvider: () => {}, walletConnectAvailable: () => false, restoreWalletConnect: async () => null };
});
vi.mock("../src/userSync", async (original) => ({
  ...await original<typeof import("../src/userSync")>(),
  pullRemoteBlob: (...args) => mocks.pull(...args),
  pushBlob: (...args) => mocks.push(...args),
  createSyncAuthorization: (...args) => mocks.authorize(...args),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["authorization", "remote read", "write acknowledgment"])(
  "preserves a local opt-out made during a delayed %s",
  async (stage) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("crypto", webcrypto);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) });
    const auth = { grant: { expiresAt: Date.now() + 60_000 } };
    let release!: (value: any) => void;
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const deferred = () => { reached(); return new Promise((resolve) => { release = resolve; }); };
    mocks.authorize.mockReset().mockResolvedValue(auth);
    mocks.pull.mockReset().mockResolvedValue(null);
    mocks.push.mockReset().mockResolvedValue({ ok: true });
    if (stage === "authorization") mocks.authorize.mockImplementationOnce(deferred);
    if (stage === "remote read") mocks.pull.mockImplementationOnce(deferred);
    if (stage === "write acknowledgment") mocks.push.mockImplementationOnce(deferred);
    let current: any;
    function Probe() { current = { ...useIdentity(), ...useSettingsPrefs() }; return null; }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(React.createElement(IdentityProvider, null,
        React.createElement(SettingsPrefsProvider, null, React.createElement(Probe)))));
      await act(async () => current.connectWallet());
      await act(async () => current.setReadReceiptsDefault(true));
      let pending: Promise<any>;
      await act(async () => { pending = current.enableSyncAcrossDevices(); await started; });
      // Same-millisecond changes must still invalidate pending operations.
      vi.spyOn(Date, "now").mockReturnValue(100);
      await act(async () => current.setReadReceiptsDefault(false));
      await act(async () => current.setChatReadReceipts("dm", false));
      let result: any;
      await act(async () => {
        release(stage === "authorization" ? auth : stage === "remote read" ? null : { ok: true });
        result = await pending;
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Settings changed while syncing");
      expect(current.prefs.readReceiptsDefault).toBe(false);
      expect(Object.values(current.prefs.readReceiptOverrides)).toEqual([false]);
      expect(current.prefs.syncAcrossDevices).toBe(false);
      expect(current.syncState.hasSessionKey).toBe(false);
      const persisted = JSON.parse(storage.get(`chat:settingsPrefs:v1:wallet:${mocks.address}`)!);
      expect(persisted.readReceiptsDefault).toBe(false);
      if (stage !== "write acknowledgment") expect(mocks.push).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
  },
);
