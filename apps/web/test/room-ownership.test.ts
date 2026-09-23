import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { RoomOwnership } from '../src/views/RoomOwnership';
const state = vi.hoisted(() => ({ updateRoomOwnership: vi.fn() }));
vi.mock('../src/state', () => ({ useChat: () => state }));
vi.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../src/ui', () => ({ Button: ({ variant: _variant, ...props }: any) => React.createElement('button', props),
  Modal: ({ title, children }: any) => React.createElement('div', { role: 'dialog', 'aria-label': title }, children) }));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
const wallet = '0x' + '2'.repeat(40);
const room = { id: 'room', kind: 'room' as const, peers: [], title: 'Room', unread: 0, deviceAccess: 'active' as const, leaveState: 'owner' as const };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; state.updateRoomOwnership.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(value: any = room) { await act(async () => root.render(React.createElement(RoomOwnership, { key: value.id, conversation: value }))); }
async function click(text: string) { await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === text)!.click()); }
async function type(value: string) { await act(async () => { const input = container.querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function submit() { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
it('requires explicit confirmation of the exact wallet; promotion never steps down automatically', async () => {
  await render(); await type(wallet); await submit();
  expect(state.updateRoomOwnership).not.toHaveBeenCalled(); expect(container.querySelector('code')!.textContent).toBe(wallet);
  await click('dialog.cancel'); expect(container.querySelector('[role="dialog"]')).toBeNull();
  await submit(); await click('ownership.confirm');
  expect(state.updateRoomOwnership).toHaveBeenCalledExactlyOnceWith('appoint', wallet);
  expect(container.textContent).toContain('ownership.appointed'); expect(container.querySelector('input')!.value).toBe('');
  await click('ownership.stepDown'); expect(container.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('ownership.stepDownTitle');
  await click('ownership.confirm'); expect(state.updateRoomOwnership).toHaveBeenLastCalledWith('step-down', undefined);
});
it.each([{ blocked: true }, { pending: true }, { deviceAccess: 'inactive' }, { leaveState: 'available' }, { leaveState: 'pending' }, { configurationError: true }])('hides controls when authority is missing: %j', async restriction => {
  await render({ ...room, ...restriction }); expect(container.childNodes).toHaveLength(0);
});
it('keeps gate-managed ownership with the operator', async () => {
  await render({ ...room, gate: { rules: [{}] } }); expect(container.textContent).toContain('ownership.managed'); expect(container.querySelector('button')).toBeNull();
});
it('retains errors and the confirmed target for explicit retry; prevents duplicate clicks', async () => {
  let fail!: (error: Error) => void; state.updateRoomOwnership.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await render(); await type(wallet); await submit(); await click('ownership.confirm'); await click('ownership.changing');
  expect(state.updateRoomOwnership).toHaveBeenCalledOnce();
  await act(async () => fail(new Error('Offline'))); expect(container.querySelector('[role="alert"]')!.textContent).toContain('Offline');
  expect(container.querySelector('code')!.textContent).toBe(wallet);
  await click('ownership.confirm'); expect(state.updateRoomOwnership).toHaveBeenCalledTimes(2);
});
it('does not publish delayed results in a different room', async () => {
  let finish!: () => void; state.updateRoomOwnership.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(); await type(wallet); await submit(); await click('ownership.confirm');
  await render({ ...room, id: 'other' }); await act(async () => finish());
  expect(container.querySelector('[role="status"]')).toBeNull(); expect(container.querySelector('[role="dialog"]')).toBeNull();
});
it('does not dispatch an invalid wallet', async () => {
  await render(); await type('invalid'); await submit(); expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(state.updateRoomOwnership).not.toHaveBeenCalled();
});
