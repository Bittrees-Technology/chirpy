import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { RoomMembers } from '../src/views/RoomMembers';
const state = vi.hoisted(() => ({ addRoomMember: vi.fn(), transportId: 'xmtp', profiles: new Map() }));
vi.mock('../src/state', () => ({ useChat: () => state }));
vi.mock('../src/usePublicProfiles', () => ({ usePublicProfiles: () => state.profiles }));
vi.mock('../src/i18n', () => ({ useI18n: () => ({ t: key => key }) }));
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const address = '0x0000000000000000000000000000000000000002';
const room = { id: 'room', kind: 'room' as const, title: 'Room', peers: [address], unread: 0, isAdmin: true, canAddMembers: true, gate: { combine: 'any' as const, rules: [] } };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  state.addRoomMember.mockReset(); state.transportId = 'xmtp'; state.profiles.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(conversation = room) { await act(async () => root.render(React.createElement(RoomMembers, { key: conversation.id, conversation }))); }
async function type(value: string) { await act(async () => {
  const input = container.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}); }
async function submit() { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
it.each([{ isAdmin: false }, { canAddMembers: false }, { configurationError: true }, { gate: { combine: 'all', rules: [{ kind: 'ens', name: 'members.eth' }] } }])('hides additions when authority is unavailable: %j', async restriction => {
  await render({ ...room, ...restriction } as any);
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('li')!.textContent).toBe(address);
});
it('retains a failed recipient and only clears it after confirmed success', async () => {
  await render(); await type(address);
  state.addRoomMember.mockRejectedValueOnce(new Error('Offline'));
  await submit(); expect(container.querySelector('input')!.value).toBe(address);
  expect(container.querySelector('[role="alert"]')!.textContent).toBe('Offline');
  state.addRoomMember.mockResolvedValue(undefined); await submit();
  expect(container.querySelector('input')!.value).toBe('');
  expect(container.querySelector('[role="status"]')!.textContent).toBe('roomMembers.added');
});
it('prevents duplicate submits and discards delayed success after changing rooms', async () => {
  let release!: () => void; state.addRoomMember.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  await render(); await type(address); await submit(); await submit();
  expect(state.addRoomMember).toHaveBeenCalledExactlyOnceWith(address);
  expect(container.querySelector('input')!.disabled).toBe(true);
  await render({ ...room, id: 'other' }); await type(address);
  await act(async () => release());
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector('input')!.value).toBe(address);
});
it('does not dispatch invalid recipients', async () => {
  await render(); await type('broken'); await submit();
  expect(state.addRoomMember).not.toHaveBeenCalled();
});

it('shows a chosen public label beside membership identity and removes a withdrawn label', async () => {
  state.profiles.set(address, { label: 'Chosen public name' }); await render();
  expect(container.querySelector('li')!.textContent).toContain('Chosen public name');
  expect(container.querySelector('code')!.textContent).toBe(address);
  state.profiles.set(address, { label: null }); await render();
  expect(container.querySelector('li')!.textContent).not.toContain('Chosen public name');
  expect(container.querySelector('code')!.textContent).toBe(address);
});
