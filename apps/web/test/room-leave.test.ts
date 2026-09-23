import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { RoomLeave } from '../src/views/RoomLeave';
const mock = vi.hoisted(() => ({ requestRoomLeave: vi.fn() }));
vi.mock('../src/state', () => ({ useChat: () => mock }));
vi.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../src/ui', () => ({ Button: ({ variant: _variant, ...props }: any) => React.createElement('button', props),
  Modal: ({ title, children }: any) => React.createElement('div', { role: 'dialog', 'aria-label': title }, children) }));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
const room = { id: 'room', kind: 'room' as const, peers: [], title: 'Room', unread: 0, leaveState: 'available' as const };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mock.requestRoomLeave.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(value: any = room) { await act(async () => root.render(React.createElement(RoomLeave, { key: value.id, conversation: value }))); }
async function click(text: string) { await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === text)!.click()); }
it('requires explicit confirmation and keeps pending removal distinct from completion', async () => {
  await render(); await click('roomLeave.action');
  expect(mock.requestRoomLeave).not.toHaveBeenCalled(); await click('dialog.cancel');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await click('roomLeave.action'); await click('roomLeave.confirm');
  expect(mock.requestRoomLeave).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('roomLeave.pending'); expect(container.textContent).not.toContain('roomLeave.removed');
  await render({ ...room, leaveState: 'removed' }); expect(container.textContent).toContain('roomLeave.removed');
  await render(room); expect(container.textContent).toContain('roomLeave.action');
});
it.each(['pending', 'removed', 'owner', 'alone', 'unavailable'])('shows %s status without an actionable leave button', async leaveState => {
  await render({ ...room, leaveState }); expect(container.textContent).toContain(`roomLeave.${leaveState}`);
  expect(container.querySelector('button')).toBeNull();
});
it.each([{ blocked: true }, { pending: true }, { leaveState: undefined }])('does not offer leave without supported accepted membership: %j', async restriction => {
  await render({ ...room, ...restriction }); expect(container.childNodes).toHaveLength(0);
});
it('retains errors for retry and suppresses duplicate dispatch while pending', async () => {
  let fail!: (e: Error) => void; mock.requestRoomLeave.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await render(); await click('roomLeave.action'); await click('roomLeave.confirm');
  expect(container.querySelectorAll('button:disabled')).toHaveLength(2);
  expect(mock.requestRoomLeave).toHaveBeenCalledOnce();
  await act(async () => fail(new Error('Offline'))); expect(container.querySelector('[role="alert"]')!.textContent).toBe('Offline');
  await click('roomLeave.confirm'); expect(mock.requestRoomLeave).toHaveBeenCalledTimes(2);
});
it('discards a delayed result after switching rooms', async () => {
  let finish!: () => void; mock.requestRoomLeave.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(); await click('roomLeave.action'); await click('roomLeave.confirm');
  await render({ ...room, id: 'other' }); await act(async () => finish());
  expect(container.textContent).toContain('roomLeave.action'); expect(container.textContent).not.toContain('roomLeave.pending');
});
