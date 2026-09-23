import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
const wallet = '0x' + '1'.repeat(40);
function setup() {
  const provider = { request: vi.fn().mockResolvedValue([wallet]) };
  const t = new XmtpTransport(PERSONAL_ORG, { address: wallet }, provider) as any;
  const group = { id: 'room', name: 'Room', description: JSON.stringify({ chirpyRoom: 1, namespace: 'personal', gate: { combine: 'any', rules: [] } }),
    metadata: { conversationType: 'group' }, sync: vi.fn(), consentState: vi.fn().mockResolvedValue(1),
    isActive: vi.fn().mockResolvedValue(true), isPendingRemoval: vi.fn().mockResolvedValue(false), isSuperAdmin: vi.fn().mockResolvedValue(false),
    members: vi.fn().mockResolvedValue([{ inboxId: 'self' }, { inboxId: 'peer' }]), requestRemoval: vi.fn(), sendText: vi.fn() };
  const client = { inboxId: 'self', conversations: { getConversationById: vi.fn().mockResolvedValue(group) } };
  Object.assign(t, { client, status: 'ready', sdk: { ConsentState: { Allowed: 1, Denied: 2, Unknown: 0 }, ConversationType: { Group: 'group' } } });
  t.conversations.set('room', group);
  return { t, group, client, provider };
}
it('requests removal after fresh membership and wallet checks, without claiming completed removal', async () => {
  const { t, group, provider } = setup();
  await t.requestRoomLeave('room');
  expect(group.sync).toHaveBeenCalledOnce(); expect(provider.request).toHaveBeenCalledTimes(2);
  expect(group.requestRemoval).toHaveBeenCalledOnce(); expect(t.consentRevision).toBe(1);
  expect(t.dirtyConversations.has('room')).toBe(true);
});
it.each(['owner', 'alone', 'inactive', 'unknown-access', 'blocked', 'request', 'foreign', 'dm', 'missing', 'scope'])('refuses leave when %s guard fails', async kind => {
  const { t, group, client } = setup();
  if (kind === 'owner') group.isSuperAdmin.mockResolvedValue(true);
  if (kind === 'alone') group.members.mockResolvedValue([{ inboxId: 'self' }]);
  if (kind === 'inactive') group.isActive.mockResolvedValue(false);
  if (kind === 'unknown-access') group.isActive.mockRejectedValue(new Error('offline'));
  if (kind === 'blocked') group.consentState.mockResolvedValue(2);
  if (kind === 'request') group.consentState.mockResolvedValue(0);
  if (kind === 'foreign') group.description = JSON.stringify({ chirpyRoom: 1, namespace: 'other' });
  if (kind === 'dm') { group.metadata.conversationType = 'dm'; delete (group as any).name; }
  if (kind === 'missing') client.conversations.getConversationById.mockResolvedValue(undefined);
  await expect(t.requestRoomLeave('room', () => kind !== 'scope')).rejects.toThrow();
  expect(group.requestRemoval).not.toHaveBeenCalled();
});
it('does not repeat an existing pending request', async () => {
  const { t, group } = setup(); group.isPendingRemoval.mockResolvedValue(true);
  await t.requestRoomLeave('room'); expect(group.requestRemoval).not.toHaveBeenCalled();
});
it('leaving never depends on retaining a room gate qualification or posting policy', async () => {
  const { t, group } = setup();
  group.description = JSON.stringify({ chirpyRoom: 1, namespace: 'personal', gate: { combine: 'all', rules: [{ kind: 'ens', name: 'members.eth' }] }, policy: { mode: 'read-only' } });
  t.assertGateAllows = vi.fn().mockRejectedValue(new Error('no longer qualifies'));
  await t.requestRoomLeave('room'); expect(group.requestRemoval).toHaveBeenCalledOnce(); expect(t.assertGateAllows).not.toHaveBeenCalled();
});
it('blocks duplicate leave requests and sends during dispatch, then permits a safe retry after failure', async () => {
  const { t, group } = setup(); let reject!: (e: Error) => void;
  group.requestRemoval.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const first = t.requestRoomLeave('room'); const rejection = expect(first).rejects.toThrow('offline');
  await vi.waitFor(() => expect(group.requestRemoval).toHaveBeenCalledOnce());
  await expect(t.requestRoomLeave('room')).rejects.toThrow('already in progress');
  await expect(t.assertConversationAccepted(group)).rejects.toThrow('Room removal');
  reject(new Error('offline')); await rejection;
  expect(t.leaveRequests.size).toBe(0); expect(t.dirtyConversations.has('room')).toBe(true);
  await t.requestRoomLeave('room'); expect(group.requestRemoval).toHaveBeenCalledTimes(2);
});
it.each(['wallet', 'client', 'scope', 'consent'])('rejects %s change during the final wallet check', async kind => {
  const { t, group, client, provider } = setup(); let current = true;
  provider.request.mockImplementationOnce(async () => [wallet]).mockImplementationOnce(async () => {
    if (kind === 'client') t.client = { ...client };
    if (kind === 'scope') current = false;
    if (kind === 'consent') group.consentState.mockResolvedValue(2);
    return [kind === 'wallet' ? '0x' + '2'.repeat(40) : wallet];
  });
  await expect(t.requestRoomLeave('room', () => current)).rejects.toThrow(); expect(group.requestRemoval).not.toHaveBeenCalled();
});
it('distinguishes active, pending, removed and inactive archived membership', async () => {
  const { t, group } = setup();
  expect(await t.roomLeaveState(group, 'active')).toBe('available');
  group.isPendingRemoval.mockResolvedValue(true); expect(await t.roomLeaveState(group, 'active')).toBe('pending');
  expect(await t.roomLeaveState(group, 'inactive')).toBe('unavailable');
  group.members.mockResolvedValue([{ inboxId: 'peer' }]);
  expect(await t.roomLeaveState(group, 'inactive')).toBe('removed');
  expect(await t.roomLeaveState(group, 'active')).toBe('unavailable');
  group.members.mockRejectedValue(new Error('offline')); expect(await t.roomLeaveState(group, 'inactive')).toBe('unavailable');
});
it('refuses sending and administration if the SDK reports pending removal or cannot check it', async () => {
  const { t, group } = setup();
  group.isPendingRemoval.mockResolvedValue(true);
  await expect(t.assertConversationAccepted(group)).rejects.toThrow('Room removal');
  group.isPendingRemoval.mockRejectedValue(new Error('check unavailable'));
  await expect(t.assertConversationAccepted(group)).rejects.toThrow();
});
