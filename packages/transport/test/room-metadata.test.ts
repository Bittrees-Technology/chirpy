import { expect, it, vi } from 'vitest';
import { encodeGate, PERSONAL_ORG } from '@app/core';
import { INVALID_ROOM_METADATA, parseRoomMeta } from '../src/roomMetadata';
import { XmtpTransport } from '../src/xmtp';
const policy = { mode: 'active', attachments: 'allow' } as const;
const open = { combine: 'any', rules: [] } as const;
const serialize = (overrides: object) => JSON.stringify({ chirpyRoom: 1, namespace: 'personal', gate: open, ...overrides });

it('preserves plain legacy descriptions and validates current object/encoded gates', () => {
  expect(parseRoomMeta('An ordinary group', policy)).toMatchObject({ description: 'An ordinary group', policy });
  expect(parseRoomMeta(undefined, policy).invalid).toBeUndefined();
  const gate = { combine: 'all' as const, rules: [{ kind: 'ens' as const, name: 'members.eth' }] };
  for (const value of [gate, encodeGate(gate)]) {
    const parsed = parseRoomMeta(serialize({ gate: value, description: 'Room', policy: { mode: 'read-only' } }), policy);
    expect(parsed).toMatchObject({ gate, namespace: 'personal', description: 'Room', policy: { mode: 'read-only', attachments: 'allow' } });
    expect(parsed.invalid).toBeUndefined();
  }
});

it.each([
  { gate: {} }, { gate: null }, { gate: { combine: 'any', rules: {} } },
  { gate: { combine: 'anything', rules: [] } }, { gate: { combine: 'all', rules: [null] } },
  { gate: 'not-a-valid-gate' }, { gate: btoa('{}') }, { gate: btoa('null') },
  { policy: null }, { policy: [] }, { policy: { mode: {} } }, { policy: { mode: 'unknown' } },
  { policy: { attachments: false } }, { policy: { maxUploadBytes: -1 } }, { policy: { maxUploadBytes: 1.5 } },
  { namespace: {} }, { namespace: '' }, { description: {} }, { description: 'x'.repeat(10001) },
  { chirpyRoom: 2 }, { gate: { combine: 'any', rules: [{ kind: 'role', role: 'admin' }] } },
])('blocks malformed or unsupported metadata case %#', override => {
  const result = parseRoomMeta(serialize(override), policy);
  expect(result).toMatchObject({ invalid: true, description: INVALID_ROOM_METADATA, gate: { rules: [] }, policy: { mode: 'read-only', attachments: 'block' } });
  expect(typeof result.namespace === 'string' || result.namespace === undefined).toBe(true);
});

it.each(['{"chirpyRoom":1,', 'x'.repeat(65537), '😀'.repeat(20000), null, {}])('bounds malformed metadata before rendering', value => {
  expect(parseRoomMeta(value, policy).invalid).toBe(true);
});

it('blocks sends, reactions and policy changes for malformed metadata even for an administrator', async () => {
  const t = new XmtpTransport(PERSONAL_ORG, { address: '0x0000000000000000000000000000000000000001' }, null) as any;
  t.sdk = { ConversationType: { Group: 'group' } }; t.client = { inboxId: 'self' }; t.status = 'ready';
  const group = { id: 'room', name: 'Room', description: serialize({ gate: 'broken' }),
    isAdmin: vi.fn().mockResolvedValue(true), isSuperAdmin: vi.fn().mockResolvedValue(true),
    sendText: vi.fn(), sendReaction: vi.fn(), updateDescription: vi.fn() };
  t.addressesForMembers = async () => []; t.unreadCount = async () => 0;
  const mapped = await t.mapRoomConversation(group);
  await expect(t.send('room', 'no')).rejects.toThrow(INVALID_ROOM_METADATA);
  await expect(t.react('room', 'message', '👍')).rejects.toThrow(INVALID_ROOM_METADATA);
  await expect(t.setRoomPolicy('room', policy)).rejects.toThrow(INVALID_ROOM_METADATA);
  expect(mapped).toMatchObject({ configurationError: true, isAdmin: true, description: INVALID_ROOM_METADATA, policy: { mode: 'read-only' } });
  expect(group.sendText).not.toHaveBeenCalled(); expect(group.sendReaction).not.toHaveBeenCalled(); expect(group.updateDescription).not.toHaveBeenCalled();
});

it('keeps invalid metadata visible as blocked when a directory supplies the missing namespace', async () => {
  const t = new XmtpTransport({ ...PERSONAL_ORG, namespace: 'org' }, { address: '0x0000000000000000000000000000000000000001' }, null) as any;
  const group = { id: 'room', name: 'Room', description: serialize({ namespace: {} }), isAdmin: async () => true };
  t.sdk = { ConversationType: { Group: 'group' } }; t.status = 'ready';
  t.client = { inboxId: 'self', conversations: { sync: vi.fn(), syncAll: vi.fn(), list: async () => [group] } };
  t.addressesForMembers = async () => []; t.unreadCount = async () => 0;
  const directoryRoom = { id: 'room', kind: 'room', namespace: 'org', title: 'Published', peers: [], unread: 0, gate: { combine: 'all', rules: [{ kind: 'ens' }] }, policy };
  t.publishedRooms = async () => [directoryRoom];
  const [room] = await t.listConversations();
  expect(room).toMatchObject({ namespace: 'org', configurationError: true, policy: { mode: 'read-only' } });
  expect(directoryRoom.policy.mode).toBe('active');
  expect(t.roomMeta.get('room').invalid).toBe(true);
});

it('rejects oversized room creation before creating a network group', async () => {
  const t = new XmtpTransport(PERSONAL_ORG, { address: '0x0000000000000000000000000000000000000001' }, null) as any;
  const createGroup = vi.fn(); t.client = { inboxId: 'self', conversations: { createGroup } }; t.sdk = {}; t.status = 'ready';
  await expect(t.createRoom({ title: 'New', description: 'x'.repeat(10001) })).rejects.toThrow('10,000 characters or fewer');
  expect(createGroup).not.toHaveBeenCalled();
});

it('validates outgoing policy metadata before writing a description', async () => {
  const t = new XmtpTransport(PERSONAL_ORG, { address: '0x0000000000000000000000000000000000000001' }, null) as any;
  const group = { id: 'room', isAdmin: async () => true, updateDescription: vi.fn() };
  t.client = { inboxId: 'self' }; t.sdk = {}; t.status = 'ready'; t.conversations.set('room', group);
  t.roomMeta.set('room', { namespace: 'personal', gate: open, policy });
  await expect(t.setRoomPolicy('room', { mode: 'invalid' })).rejects.toThrow(INVALID_ROOM_METADATA);
  expect(group.updateDescription).not.toHaveBeenCalled();
});
