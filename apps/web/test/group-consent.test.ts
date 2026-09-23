import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Thread } from '../src/views/Thread';
import { ConversationColumn } from '../src/views/List';
const state = vi.hoisted(() => ({ chat: {} as any, identity: { address: '0x1' }, org: { namespace: 'personal' }, profiles: vi.fn(), consent: vi.fn() }));
vi.mock('../src/state', () => ({ useChat: () => state.chat, useIdentity: () => ({ identity: state.identity, mode: 'wallet' }), useOrgs: () => ({ activeOrg: state.org }),
  useSettingsPrefs: () => ({ prefs: { readReceiptsDefault: false, readReceiptOverrides: {} }, setChatReadReceipts: vi.fn() }) }));
vi.mock('../src/usePublicProfiles', () => ({ usePublicProfiles: state.profiles, publicName: (a, _p, _e, custom) => custom || a }));
vi.mock('../src/useEns', () => ({ useEnsProfiles: () => new Map() }));
vi.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key, fallback) => fallback || key, lang: 'en' }) }));
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const room = { id: 'group', kind: 'room', title: 'Native group', peers: ['0x1', '0x2'], unread: 1, consentSupported: true, policy: { mode: 'active' } };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; HTMLElement.prototype.scrollIntoView = vi.fn();
  state.identity = { address: '0x1' }; state.org = { namespace: 'personal' };
  state.consent.mockReset().mockResolvedValue(undefined); state.profiles.mockReset().mockReturnValue(new Map());
  state.chat = { activeConversation: { ...room }, conversations: [room], messages: [{ id: 'm', sender: '0x2', body: 'Secret incoming text', sentAt: 1 }],
    setConversationConsent: state.consent, markRead: vi.fn().mockResolvedValue(undefined), react: vi.fn(), send: vi.fn(), transportId: 'xmtp', pushSource: null };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(React.createElement(Thread))); }
function button(text: string) { return Array.from(container.querySelectorAll('button')).find(b => b.textContent === text); }
async function click(text: string) { await act(async () => button(text)!.click()); }
async function type(text: string) { await act(async () => { const input = container.querySelector('.composer-input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
it('offers explicit invitation acceptance/rejection, blocks reply/react, and does not expose group receipts', async () => {
  state.chat.activeConversation.pending = true; await render();
  expect(button('Accept request')).toBeTruthy(); expect(button('Reject and block')).toBeTruthy();
  expect(container.querySelector('.composer-input')).toBeNull();
  expect(Array.from(container.querySelectorAll<HTMLButtonElement>('.react-btn')).map(b => [b.getAttribute('aria-label'), b.disabled])).toContainEqual(['React with 👍', true]);
  expect(container.querySelector('[aria-label="Send read receipts"]')).toBeNull();
  await click('Accept request'); expect(state.consent).toHaveBeenLastCalledWith('allowed');
  await click('Reject and block'); expect(state.consent).toHaveBeenLastCalledWith('denied');
});
it('immediately hides loaded group text, profiles, roster, replies and composer on block, retaining only the users draft', async () => {
  await render(); await type('My unsent draft');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reply"]')!.click());
  state.chat.activeConversation = { ...room, blocked: true }; state.profiles.mockClear(); await render();
  expect(container.textContent).not.toContain('Secret incoming text');
  expect(container.querySelector('.room-members')).toBeNull(); expect(container.querySelector('.composer-input')).toBeNull();
  expect(state.profiles.mock.calls.every(call => call[0].length === 0)).toBe(true);
  expect(container.textContent).toContain('does not remove you from the room');
  await click('Unblock conversation'); expect(state.consent).toHaveBeenCalledWith('allowed');
  state.chat.activeConversation = { ...room }; await render();
  expect(container.querySelector<HTMLInputElement>('.composer-input')!.value).toBe('My unsent draft');
  expect(container.querySelector('.reply-banner')).toBeNull();
});
it('keeps directory joins separate and never applies native consent to Push', async () => {
  state.chat.activeConversation = { ...room, consentSupported: undefined, peers: [], gate: { rules: [{ kind: 'ens' }] } }; await render();
  expect(button('Request to join')).toBeTruthy(); expect(button('Block conversation')).toBeUndefined(); expect(button('Accept request')).toBeUndefined();
  state.chat.activeConversation = { ...room, push: { source: 'governance', membership: 'none', publicRoom: false } }; await render();
  expect(button('Block conversation')).toBeUndefined(); expect(button('Accept request')).toBeUndefined();
});
it('ignores delayed consent errors after changing wallet and returning to the same room', async () => {
  let reject!: (e: Error) => void; state.consent.mockImplementation(() => new Promise((_, r) => { reject = r; }));
  await render(); await click('Block conversation');
  state.identity = { address: '0x3' }; await render(); state.identity = { address: '0x1' }; await render();
  await act(async () => reject(new Error('Old wallet error')));
  expect(container.textContent).not.toContain('Old wallet error'); expect(button('Block conversation')!.disabled).toBe(false);
});
const props = { title: 'Rooms', mode: 'rooms' as const, onNewDm: vi.fn(), onNewRoom: vi.fn(), onLocalData: vi.fn(), needsConnect: false, onOpenSettings: vi.fn(), onOpenConversation: vi.fn() };
async function list() { await act(async () => root.render(React.createElement(ConversationColumn, props))); }
it('separates accepted, requested and blocked rooms and resets filters across organization/source changes', async () => {
  state.chat.conversations = [{ ...room, title: 'Accepted room' }, { ...room, id: 'request', title: 'Invited room', pending: true }, { ...room, id: 'block', title: 'Blocked room', blocked: true }];
  await list(); expect(container.textContent).toContain('Accepted room'); expect(container.textContent).not.toContain('Invited room');
  await click('Requests'); expect(container.textContent).toContain('Invited room'); expect(container.textContent).not.toContain('Accepted room');
  await click('Blocked'); expect(container.textContent).toContain('Blocked room'); expect(container.textContent).not.toContain('Invited room');
  state.org = { namespace: 'different' }; await list(); expect(button('Inbox')!.getAttribute('aria-pressed')).toBe('true');
  await click('Blocked'); state.chat.pushSource = 'governance'; await list(); expect(button('Blocked')).toBeUndefined(); expect(container.textContent).toContain('Accepted room');
});
