import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { IdentityProvider, OrgProvider, SettingsPrefsProvider, ChatProvider, useChat, useSettingsPrefs } from "../src/state";
const mock = vi.hoisted(() => ({ markRead: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@app/transport", () => ({ createTransport: () => ({ id: "mock", status: "ready", init: async () => {}, listConversations: async () => [], listMessages: async () => [], subscribe: () => () => {}, markRead: mock.markRead }) }));
vi.mock("../src/ens", () => ({ resolveEns: async () => null }));
it("passes the actual current Settings preference to the transport", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) });
  let chat; let settings;
  function Probe() { chat = useChat(); settings = useSettingsPrefs(); return null; }
  const container = document.createElement("div"); const root = createRoot(container);
  const element = [ChatProvider, OrgProvider, SettingsPrefsProvider, IdentityProvider].reduce((child, Provider) => React.createElement(Provider, null, child), React.createElement(Probe));
  try {
    await act(async () => root.render(element));
    await act(async () => settings.setReadReceiptsDefault(false));
    await act(async () => chat.select("dm"));
    await act(async () => chat.markRead("seen"));
    expect(mock.markRead).toHaveBeenLastCalledWith("dm", { sendReceipt: false, throughMessageId: "seen" });
    await act(async () => settings.setReadReceiptsDefault(true));
    await act(async () => chat.select("dm"));
    await act(async () => chat.markRead("seen"));
    expect(mock.markRead).toHaveBeenLastCalledWith("dm", { sendReceipt: true, throughMessageId: "seen" });
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
