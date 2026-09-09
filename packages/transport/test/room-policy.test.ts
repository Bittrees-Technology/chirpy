import { expect, it, vi } from 'vitest';
import { XmtpTransport } from '../src/xmtp';
import { PERSONAL_ORG } from '@app/core';
const address = '0x0000000000000000000000000000000000000001';
function setup() {
  const t = new XmtpTransport(PERSONAL_ORG, { address }, null) as any;
  t.sdk = { ConversationType: { Group: 'group' }, ConsentState: { Allowed: 1 } };
  t.client = { inboxId: 'self' }; t.status = 'ready';
  const room = { id: 'room', name: 'Room', isAdmin: vi.fn(async () => false), isSuperAdmin: vi.fn(async () => false), sendReaction: vi.fn(), updateDescription: vi.fn() };
  t.conversations.set('room', room);
  t.roomMeta.set('room', { gate: { combine: 'all', rules: [] }, policy: { mode: 'read-only', attachments: 'allow' } });
  return { t, room };
}
it('paused rooms reject member reactions before any message query or send', async () => {
  const { t, room } = setup();
  await expect(t.react('room', 'message', '👍')).rejects.toThrow('read-only');
  expect(room.sendReaction).not.toHaveBeenCalled();
});
it('production reactions reject unsupported gates even if an any-rule could otherwise pass', async () => {
  const { t, room } = setup();
  t.roomMeta.get('room').gate.rules = [{ kind: 'role', role: 'member' }, { kind: 'ens' }];
  await expect(t.react('room', 'message', '👍')).rejects.toThrow('unsupported production gate');
  expect(room.sendReaction).not.toHaveBeenCalled();
});
it('super-admins can update policy, while a failed update preserves the authoritative local policy', async () => {
  const { t, room } = setup(); room.isSuperAdmin.mockResolvedValue(true);
  const original = t.roomMeta.get('room');
  const policy = { mode: 'active', attachments: 'block' };
  room.updateDescription.mockRejectedValueOnce(new Error('offline'));
  await expect(t.setRoomPolicy('room', policy)).rejects.toThrow('offline');
  expect(t.roomMeta.get('room')).toBe(original);
  await t.setRoomPolicy('room', policy);
  expect(t.roomMeta.get('room').policy).toEqual(policy);
});
it('non-admins cannot update room policy', async () => {
  const { t, room } = setup();
  await expect(t.setRoomPolicy('room', { mode: 'active' })).rejects.toThrow('Admins only');
  expect(room.updateDescription).not.toHaveBeenCalled();
});

it('derives displayed authority from the SDK and fails closed if role checks fail', async () => {
  const { t, room } = setup();
  t.addressesForMembers = async () => [address]; t.unreadCount = async () => 0;
  room.isAdmin.mockResolvedValue(true);
  expect((await t.mapRoomConversation(room)).isAdmin).toBe(true);
  room.isAdmin.mockRejectedValue(new Error('offline'));
  room.isSuperAdmin.mockRejectedValue(new Error('offline'));
  expect((await t.mapRoomConversation(room)).isAdmin).toBe(false);
  await expect(t.setRoomPolicy('room', { mode: 'active' })).rejects.toThrow('Admins only');
  expect(room.updateDescription).not.toHaveBeenCalled();
});
