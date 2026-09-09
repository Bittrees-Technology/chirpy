import { afterEach, expect, it, vi } from 'vitest';
import { XmtpTransport } from '../src/xmtp';
import { PERSONAL_ORG, type Policy, type Gate } from '@app/core';
const make = () => new XmtpTransport(PERSONAL_ORG, { address: '0x0000000000000000000000000000000000000001' }, null) as any;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('shares concurrent inbox refreshes and permits a later retry after failure', async () => {
  const t = make(); t.status = 'ready';
  let finish!: () => void;
  const sync = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const list = vi.fn().mockResolvedValue([]);
  t.client = { conversations: { sync, syncAll: vi.fn(), list } };
  const first = t.listConversations(); const second = t.listConversations();
  expect(first).toBe(second); expect(sync).toHaveBeenCalledTimes(1);
  finish(); await first; expect(list).toHaveBeenCalledTimes(1);
  sync.mockRejectedValueOnce(new Error('offline'));
  await expect(t.listConversations()).rejects.toThrow();
  sync.mockResolvedValue(undefined); await t.listConversations();
  expect(sync).toHaveBeenCalledTimes(3);
});
it('polling notifies once without fetching twice and pauses while hidden', async () => {
  vi.useFakeTimers(); const t = make(); t.status = 'ready';
  t.listConversations = vi.fn(); t.runStream = vi.fn();
  const cb = vi.fn(); const doc = { visibilityState: 'visible' };
  vi.stubGlobal('document', doc); t.startPoll(cb);
  await vi.advanceTimersByTimeAsync(10000); expect(cb).toHaveBeenCalledTimes(1);
  expect(t.listConversations).not.toHaveBeenCalled();
  doc.visibilityState = 'hidden'; await vi.advanceTimersByTimeAsync(30000);
  expect(cb).toHaveBeenCalledTimes(1); clearInterval(t.pollTimer);
});

it('preserves a joined room posting policy while applying the trusted directory gate', async () => {
  const t = make(); t.status = 'ready';
  const paused: Policy = { mode: 'read-only', attachments: 'block' };
  const directoryPolicy: Policy = { mode: 'active', attachments: 'allow', maxUploadBytes: 1000 };
  const directoryGate: Gate = { combine: 'all', rules: [{ type: 'ens', name: 'members.eth' }] };
  const joined = { id: 'joined' };
  t.client = { conversations: { sync: vi.fn(), syncAll: vi.fn(), list: vi.fn().mockResolvedValue([joined]) } };
  t.mapConversation = vi.fn(async () => {
    t.roomMeta.set('joined', { namespace: 'personal', gate: [], policy: paused, description: 'Paused by admin' });
    return { id: 'joined', kind: 'room', namespace: 'personal', title: 'Joined', peers: [], gate: [], policy: paused, unread: 0 };
  });
  t.publishedRooms = vi.fn().mockResolvedValue([
    { id: 'joined', kind: 'room', namespace: 'personal', title: 'Directory name', peers: [], gate: directoryGate, policy: directoryPolicy, unread: 0 },
    { id: 'discoverable', kind: 'room', namespace: 'personal', title: 'Discoverable', peers: [], gate: directoryGate, policy: directoryPolicy, unread: 0 },
  ]);
  const rooms = await t.listConversations();
  expect(t.roomMeta.get('joined')).toMatchObject({ policy: paused, gate: directoryGate, description: 'Paused by admin' });
  expect(rooms.find((room: any) => room.id === 'joined')).toMatchObject({ policy: paused, gate: directoryGate, title: 'Joined' });
  expect(t.roomMeta.get('discoverable')).toMatchObject({ policy: directoryPolicy, gate: directoryGate });
  t.assertConversationAccepted = vi.fn(); t.assertGateAllows = vi.fn();
  t.isCurrentUserAdmin = vi.fn().mockResolvedValue(false); t.loadSdk = vi.fn().mockResolvedValue({});
  await expect(t.send('joined', 'Should remain paused')).rejects.toThrow('read-only');
  await expect(t.react('joined', 'message', '👍')).rejects.toThrow('read-only');
});

it('keeps the existing posting restriction while refreshed room metadata is pending', async () => {
  const t = make(); t.status = 'ready';
  const policy: Policy = { mode: 'read-only', attachments: 'allow' };
  const conversation = { id: 'room', sendText: vi.fn().mockResolvedValue('unexpected-send') };
  t.conversations.set('room', conversation);
  t.roomMeta.set('room', { gate: { combine: 'all', rules: [] }, policy });
  t.roomMeta.set('departed', { gate: { combine: 'all', rules: [] }, policy });
  t.client = { conversations: { sync: vi.fn(), syncAll: vi.fn(), list: vi.fn().mockResolvedValue([conversation]) } };
  let finish: ((value: unknown) => void) | undefined;
  t.mapConversation = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  t.publishedRooms = vi.fn().mockResolvedValue([]);
  t.assertConversationAccepted = vi.fn(); t.assertGateAllows = vi.fn();
  t.isCurrentUserAdmin = vi.fn().mockResolvedValue(false); t.loadSdk = vi.fn().mockResolvedValue({});
  const refresh = t.listConversations();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  try {
    await expect(t.send('room', 'While refreshing')).rejects.toThrow('read-only');
    await expect(t.react('room', 'message', '👍')).rejects.toThrow('read-only');
    expect(conversation.sendText).not.toHaveBeenCalled();
  } finally {
    finish!({ id: 'room', kind: 'room', namespace: 'personal', policy, peers: [], unread: 0 });
    await refresh;
  }
  expect(t.roomMeta.has('departed')).toBe(false);
  t.mapConversation.mockRejectedValueOnce(new Error('metadata unavailable'));
  await expect(t.listConversations()).rejects.toThrow('metadata unavailable');
  await expect(t.send('room', 'After failed refresh')).rejects.toThrow('read-only');
  expect(conversation.sendText).not.toHaveBeenCalled();
});
