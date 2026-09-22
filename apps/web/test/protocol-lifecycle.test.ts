import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { IdentityProvider, OrgProvider, SettingsPrefsProvider, ChatProvider, useChat } from '../src/state';
const mock = vi.hoisted(() => ({ init: vi.fn(), nativePage: vi.fn(), pushPage: vi.fn(), notify: null as null | (() => void), getAdapter: vi.fn() }));
vi.mock('@app/transport', async importOriginal => ({ ...await importOriginal<typeof import('@app/transport')>(), createTransport: () => ({
  id: 'mock', status: 'ready', init: mock.init, listConversations: async () => [], listMessagePage: mock.nativePage,
  subscribe: (notify: () => void) => { mock.notify = notify; return () => { mock.notify = null; }; },
}) }));
vi.mock('../src/usePushRooms', () => ({ usePushRooms: () => ({ getAdapter: mock.getAdapter, connectionRevision: 0, snapshot: { rooms: [], status: 'ready' } }) }));
vi.mock('../src/ens', () => ({ resolveEns: async () => null }));
const pushId = 'push:production:governance:' + 'a'.repeat(64);
let root: ReturnType<typeof createRoot>; let chat: ReturnType<typeof useChat>;
async function mount() {
  function Probe() { chat = useChat(); return null; }
  const element = [ChatProvider, OrgProvider, SettingsPrefsProvider, IdentityProvider].reduce((child, Provider) => React.createElement(Provider, null, child), React.createElement(Probe));
  await act(async () => root.render(element));
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const storage = new Map(); vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  mock.init.mockResolvedValue(undefined); mock.nativePage.mockResolvedValue({ messages: [] });
  mock.pushPage.mockResolvedValue({ messages: [{ id: 'push-message', conversationId: pushId, sender: '0x' + '1'.repeat(40), body: 'Push history', sentAt: 1 }] });
  const rooms = { getSnapshot: () => ({ status: 'ready' }), history: mock.pushPage };
  mock.getAdapter.mockReturnValue(rooms); root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('keeps a selected Push room when native transport initialization finishes later', async () => {
  let finish!: () => void; mock.init.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await mount(); await act(async () => chat.select(pushId));
  expect(chat.messages[0].body).toBe('Push history');
  await act(async () => finish());
  expect(chat.activeId).toBe(pushId); expect(chat.messages[0].body).toBe('Push history');
});
it('refreshes native events only through their own protocol while Push stays independently refreshed', async () => {
  await mount(); await act(async () => chat.select(pushId)); expect(mock.pushPage).toHaveBeenCalledOnce();
  await act(async () => { mock.notify?.(); await vi.advanceTimersByTimeAsync(150); });
  expect(mock.pushPage).toHaveBeenCalledOnce(); expect(chat.messages[0].body).toBe('Push history');
  await act(async () => chat.select('native-room')); expect(mock.nativePage).toHaveBeenCalledOnce();
  await act(async () => { mock.notify?.(); await vi.advanceTimersByTimeAsync(150); }); expect(mock.nativePage).toHaveBeenCalledTimes(2);
});
