import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
const self = '0x' + '1'.repeat(40), peer = '0x' + '2'.repeat(40);
function setup() {
  let owners = ['self'];
  const provider = { request: vi.fn().mockResolvedValue([self]) };
  const t = new XmtpTransport(PERSONAL_ORG, { address: self }, provider) as any;
  const group = { id: 'room', name: 'Room', metadata: { conversationType: 'group' }, description: JSON.stringify({ chirpyRoom: 1, namespace: 'personal', gate: { combine: 'any', rules: [] } }),
    sync: vi.fn(), consentState: vi.fn().mockResolvedValue(1), isActive: vi.fn().mockResolvedValue(true), isPendingRemoval: vi.fn().mockResolvedValue(false),
    members: vi.fn().mockResolvedValue([{ inboxId: 'self' }, { inboxId: 'peer' }]), listSuperAdmins: vi.fn(async () => [...owners]),
    addSuperAdmin: vi.fn(async (id: string) => { owners.push(id); }), removeSuperAdmin: vi.fn(async (id: string) => { owners = owners.filter(owner => owner !== id); }),
    requestRemoval: vi.fn() };
  const client = { inboxId: 'self', fetchInboxIdByIdentifier: vi.fn().mockResolvedValue('peer'), conversations: { getConversationById: vi.fn().mockResolvedValue(group) } };
  Object.assign(t, { client, status: 'ready', sdk: { ConsentState: { Allowed: 1 }, ConversationType: { Group: 'group' }, IdentifierKind: { Ethereum: 0 } } });
  t.conversations.set('room', group);
  t.publishedRooms = vi.fn().mockResolvedValue([]);
  return { t, group, client, provider, setOwners: (ids: string[]) => { owners = ids; } };
}
it('appoints only a current member and keeps the current owner until a separate step-down', async () => {
  const { t, group, client, provider } = setup();
  await t.updateRoomOwnership('room', 'appoint', peer);
  expect(client.fetchInboxIdByIdentifier).toHaveBeenCalledWith({ identifier: peer, identifierKind: 0 });
  expect(group.addSuperAdmin).toHaveBeenCalledExactlyOnceWith('peer'); expect(group.removeSuperAdmin).not.toHaveBeenCalled();
  expect(await group.listSuperAdmins()).toEqual(['self', 'peer']);
  expect(provider.request).toHaveBeenCalledTimes(2); expect(group.sync).toHaveBeenCalledTimes(2);
  await t.updateRoomOwnership('room', 'step-down');
  expect(group.removeSuperAdmin).toHaveBeenCalledExactlyOnceWith('self'); expect(await group.listSuperAdmins()).toEqual(['peer']);
  expect(group.requestRemoval).not.toHaveBeenCalled(); expect(t.consentRevision).toBe(2); expect(t.dirtyConversations.has('room')).toBe(true);
});
it('refuses the last member-owner even if a stale owner list contains nonmembers', async () => {
  const { t, group, setOwners } = setup();
  await expect(t.updateRoomOwnership('room', 'step-down')).rejects.toThrow('Appoint another');
  setOwners(['self', 'former']);
  await expect(t.updateRoomOwnership('room', 'step-down')).rejects.toThrow('Appoint another');
  expect(group.removeSuperAdmin).not.toHaveBeenCalled();
});
it.each(['outsider', 'unknown', 'self', 'linked-self', 'blocked', 'pending', 'inactive', 'removing', 'not-owner', 'not-member', 'foreign', 'gated', 'directory', 'directory-offline', 'cached-gate', 'invalid', 'dm', 'missing', 'wrong-id', 'action'])('refuses unsafe ownership change: %s', async kind => {
  const { t, group, client, setOwners } = setup();
  if (kind === 'outsider') client.fetchInboxIdByIdentifier.mockResolvedValue('outsider');
  if (kind === 'unknown') client.fetchInboxIdByIdentifier.mockResolvedValue(undefined);
  if (kind === 'linked-self') client.fetchInboxIdByIdentifier.mockResolvedValue('self');
  if (kind === 'blocked') group.consentState.mockResolvedValue(2);
  if (kind === 'pending') group.consentState.mockResolvedValue(0);
  if (kind === 'inactive') group.isActive.mockResolvedValue(false);
  if (kind === 'removing') group.isPendingRemoval.mockResolvedValue(true);
  if (kind === 'not-owner') setOwners(['peer']);
  if (kind === 'not-member') group.members.mockResolvedValue([{ inboxId: 'peer' }]);
  if (kind === 'foreign') group.description = JSON.stringify({ chirpyRoom: 1, namespace: 'other' });
  if (kind === 'gated') group.description = JSON.stringify({ chirpyRoom: 1, namespace: 'personal', gate: { combine: 'any', rules: [{ kind: 'ens', name: 'member.eth' }] } });
  if (kind === 'directory') t.publishedRooms.mockResolvedValue([{ id: 'room' }]);
  if (kind === 'directory-offline') t.publishedRooms.mockRejectedValue(new Error('directory offline'));
  if (kind === 'cached-gate') t.roomMeta.set('room', { gate: { rules: [{}] } });
  if (kind === 'invalid') group.description = '{"chirpyRoom":99}';
  if (kind === 'dm') { group.metadata.conversationType = 'dm'; delete (group as any).name; }
  if (kind === 'missing') client.conversations.getConversationById.mockResolvedValue(undefined);
  if (kind === 'wrong-id') group.id = 'other';
  await expect(t.updateRoomOwnership('room', kind === 'action' ? 'delete' : 'appoint', kind === 'self' ? self : peer)).rejects.toThrow();
  expect(group.addSuperAdmin).not.toHaveBeenCalled(); expect(group.removeSuperAdmin).not.toHaveBeenCalled();
});
it.each(['wallet', 'client', 'scope', 'role', 'membership', 'consent', 'gate'])('rechecks %s after a delayed wallet check', async kind => {
  const { t, group, client, provider, setOwners } = setup(); let current = true;
  provider.request.mockImplementationOnce(async () => [self]).mockImplementationOnce(async () => {
    if (kind === 'client') t.client = { ...client };
    if (kind === 'scope') current = false;
    if (kind === 'role') setOwners(['peer']);
    if (kind === 'membership') group.members.mockResolvedValue([{ inboxId: 'self' }]);
    if (kind === 'consent') group.consentState.mockResolvedValue(2);
    if (kind === 'gate') group.description = JSON.stringify({ chirpyRoom: 1, namespace: 'personal', gate: { combine: 'any', rules: [{ kind: 'ens', name: 'member.eth' }] } });
    return [kind === 'wallet' ? peer : self];
  });
  await expect(t.updateRoomOwnership('room', 'appoint', peer, () => current)).rejects.toThrow(); expect(group.addSuperAdmin).not.toHaveBeenCalled();
});
it('rechecks the remaining owner after the wallet read before stepping down', async () => {
  const { t, group, provider, setOwners } = setup(); setOwners(['self', 'peer']);
  provider.request.mockImplementationOnce(async () => [self]).mockImplementationOnce(async () => { setOwners(['self']); return [self]; });
  await expect(t.updateRoomOwnership('room', 'step-down')).rejects.toThrow('Appoint another'); expect(group.removeSuperAdmin).not.toHaveBeenCalled();
});
it('retries a completed promotion safely after a lost acknowledgement; step-down failure leaves both owners', async () => {
  const { t, group, setOwners } = setup();
  group.addSuperAdmin.mockImplementationOnce(async () => { setOwners(['self', 'peer']); throw new Error('lost acknowledgement'); });
  await expect(t.updateRoomOwnership('room', 'appoint', peer)).rejects.toThrow('lost acknowledgement');
  await t.updateRoomOwnership('room', 'appoint', peer); expect(group.addSuperAdmin).toHaveBeenCalledOnce();
  group.removeSuperAdmin.mockRejectedValueOnce(new Error('offline'));
  await expect(t.updateRoomOwnership('room', 'step-down')).rejects.toThrow('offline');
  expect(await group.listSuperAdmins()).toEqual(['self', 'peer']);
  await t.updateRoomOwnership('room', 'step-down'); expect(await group.listSuperAdmins()).toEqual(['peer']);
});
it('rejects duplicate changes while a role commit is outstanding', async () => {
  const { t, group } = setup(); let finish!: () => void;
  group.addSuperAdmin.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = t.updateRoomOwnership('room', 'appoint', peer);
  await vi.waitFor(() => expect(group.addSuperAdmin).toHaveBeenCalledOnce());
  await expect(t.updateRoomOwnership('room', 'step-down')).rejects.toThrow('already in progress');
  finish(); await first; expect(t.ownershipUpdates.size).toBe(0);
});
it.each(['target', 'owner', 'last-owner'])('rechecks %s after the final asynchronous consent read', async kind => {
  const { t, group, setOwners } = setup();
  if (kind === 'last-owner') setOwners(['self', 'peer']);
  group.consentState.mockImplementationOnce(async () => 1).mockImplementationOnce(async () => 1).mockImplementationOnce(async () => {
    if (kind === 'target') group.members.mockResolvedValue([{ inboxId: 'self' }]);
    if (kind === 'owner') setOwners(['peer']);
    if (kind === 'last-owner') setOwners(['self']);
    return 1;
  });
  await expect(t.updateRoomOwnership('room', kind === 'last-owner' ? 'step-down' : 'appoint', peer)).rejects.toThrow();
  expect(group.addSuperAdmin).not.toHaveBeenCalled(); expect(group.removeSuperAdmin).not.toHaveBeenCalled();
});
it.each(['revision', 'consent', 'leave'])('rejects %s authority changes during the final roster read', async kind => {
  const { t, group } = setup();
  group.members.mockImplementationOnce(async () => [{ inboxId: 'self' }, { inboxId: 'peer' }])
    .mockImplementationOnce(async () => [{ inboxId: 'self' }, { inboxId: 'peer' }])
    .mockImplementationOnce(async () => {
      if (kind === 'revision') t.consentRevision++;
      if (kind === 'consent') t.consentUpdates.add('room');
      if (kind === 'leave') t.leaveRequests.add('room');
      return [{ inboxId: 'self' }, { inboxId: 'peer' }];
    });
  await expect(t.updateRoomOwnership('room', 'appoint', peer)).rejects.toThrow('Room authority changed');
  expect(group.addSuperAdmin).not.toHaveBeenCalled();
});
