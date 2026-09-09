import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { IdentityProvider, OrgProvider, SettingsPrefsProvider, ChatProvider, useChat } from '../src/state';
const mock = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('@app/transport', () => ({ createTransport: () => ({ id: 'mock', status: 'ready', init: async () => {}, listConversations: async () => [], listMessagePage: mock.page, subscribe: () => () => {} }) }));
vi.mock('../src/ens', () => ({ resolveEns: async () => null }));
afterEach(() => { vi.unstubAllGlobals(); mock.page.mockReset(); });
it('ignores a delayed history response after switching chats and resets navigation on reselection', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const storage = new Map();
  vi.stubGlobal('localStorage', { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) });
  let chat; let finish!: (value: unknown) => void;
  mock.page.mockImplementation(async (id, before) => before === '100' ? new Promise(resolve => { finish = resolve; }) : ({ messages: [{ id, body: id }], olderCursor: '100' }));
  function Probe() { chat = useChat(); return null; }
  const root = createRoot(document.createElement('div'));
  const element = [ChatProvider, OrgProvider, SettingsPrefsProvider, IdentityProvider].reduce((child, Provider) => React.createElement(Provider, null, child), React.createElement(Probe));
  try {
    await act(async () => root.render(element));
    await act(async () => chat.select('first'));
    expect(chat.messages[0].id).toBe('first');
    await act(async () => chat.navigateHistory('older'));
    expect(chat.isHistory).toBe(true); expect(chat.historyLoading).toBe(true);
    await act(async () => chat.select('second'));
    expect(chat.messages[0].id).toBe('second'); expect(chat.isHistory).toBe(false);
    await act(async () => finish({ messages: [{ id: 'stale-history' }], olderCursor: '50' }));
    expect(chat.messages[0].id).toBe('second'); expect(chat.historyLoading).toBe(false);
    await act(async () => chat.select('second'));
    expect(chat.messages[0].id).toBe('second');
  } finally { await act(async () => root.unmount()); }
});
