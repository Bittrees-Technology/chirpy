import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ConversationColumn } from '../src/views/List';
import { I18nProvider } from '../src/i18n';
vi.mock('../src/state', () => ({
  useChat: () => ({ conversations: [], select: vi.fn(), startDm: vi.fn() }),
  useIdentity: () => ({ identity: { address: '0x123' }, mode: 'wallet' }),
  useOrgs: () => ({ activeOrg: { namespace: 'personal' } }),
}));
vi.mock('../src/useEns', () => ({ useEnsProfiles: () => new Map() }));
vi.mock('../src/usePublicProfiles', () => ({ usePublicProfiles: () => new Map(), publicName: () => '' }));
it('offers recovery from an empty inbox without issuing requests and keeps filtered emptiness distinct', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); const root = createRoot(host);
  const settings = vi.fn();
  const render = (mode: 'chats' | 'rooms', needsConnect = false) => root.render(React.createElement(I18nProvider, null,
    React.createElement(ConversationColumn, { title: mode, mode, needsConnect, onOpenSettings: settings, onNewDm: vi.fn(), onNewRoom: vi.fn(), onOpenConversation: vi.fn(), onLocalData: vi.fn() })));
  try {
    await act(async () => render('chats'));
    expect(host.textContent).toContain('No chats in this inbox');
    expect(host.textContent).toContain('A new browser may not have your earlier messages');
    expect(settings).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('section[aria-label="Message history"] button')!.click());
    expect(settings).toHaveBeenCalledTimes(1);
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Requests')!.click());
    expect(host.textContent).toContain('No message requests');
    expect(host.querySelector('section[aria-label="Message history"]')).toBeNull();
    await act(async () => render('rooms'));
    expect(host.querySelector('section[aria-label="Message history"]')).toBeNull();
    await act(async () => render('chats', true));
    expect(host.querySelector('section[aria-label="Message history"]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
