import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Thread } from '../src/views/Thread';
import { I18nProvider } from '../src/i18n';
const state = vi.hoisted(() => ({ chat: {} as any, markRead: vi.fn(), connect: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/state', () => ({ useChat: () => state.chat, useIdentity: () => ({ identity: { address: '0x' + '1'.repeat(40) } }), useSettingsPrefs: () => ({ prefs: {} }) }));
vi.mock('../src/useEns', () => ({ useEnsProfiles: () => new Map(), nameFor: (id: string) => id }));
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
async function render() { await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Thread)))); }
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  state.markRead.mockReset(); state.connect.mockClear();
  state.chat = { activeConversation: { id: 'push:production:governance:' + 'a'.repeat(64), kind: 'room', title: 'Original room', peers: [], push: { source: 'governance', membership: 'unknown', canSend: false, canJoin: false, canModerate: false } }, messages: [], pushStatus: 'idle', markRead: state.markRead, enablePushRooms: state.connect };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
it('shows unknown visibility and membership without inventing member counts or open admission', async () => {
  await render(); expect(container.textContent).toContain('Visibility not checked'); expect(container.textContent).toContain('Membership not checked');
  expect(container.textContent).not.toContain('0 members'); expect(container.querySelector('.composer-input')).toBeNull();
  const connect = [...container.querySelectorAll('button')].find(button => button.textContent === 'Connect Push rooms')!;
  await act(async () => connect.click()); expect(state.connect).toHaveBeenCalledOnce();
});
it('keeps pending members read-only and hides XMTP actions even when messages are present', async () => {
  state.chat.pushStatus = 'ready'; state.chat.activeConversation.push.membership = 'pending';
  state.chat.messages = [{ id: 'message', sender: '0x' + '2'.repeat(40), body: 'existing history', sentAt: 1 }];
  vi.spyOn(document, 'hasFocus').mockReturnValue(true); vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ height: 1 }] as any);
  await render(); expect(container.textContent).toContain('Membership pending'); expect(container.textContent).toContain('existing history');
  expect(container.querySelector('.composer-input')).toBeNull(); expect(container.querySelector('.msg-tools')).toBeNull(); expect(state.markRead).not.toHaveBeenCalled();
});
it('removes posting and moderation controls when current permissions are revoked', async () => {
  state.chat.pushStatus = 'ready'; Object.assign(state.chat.activeConversation.push, { membership: 'member', canSend: true, canModerate: true });
  await render(); expect(container.querySelector('.composer-input')).not.toBeNull(); expect(container.querySelector('[aria-label="Member wallet"]')).not.toBeNull();
  Object.assign(state.chat.activeConversation.push, { canSend: false, canModerate: false });
  await render(); expect(container.querySelector('.composer-input')).toBeNull(); expect(container.querySelector('[aria-label="Member wallet"]')).toBeNull();
});
it('shows history failures and does not present them as successfully loaded empty rooms', async () => {
  state.chat.historyError = 'Join this private room before reading its history.';
  await render(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('Join this private room'); expect(container.textContent).not.toContain('No messages yet');
});
