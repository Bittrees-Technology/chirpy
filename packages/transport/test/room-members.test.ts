import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
const self = '0x0000000000000000000000000000000000000001';
const peer = '0x0000000000000000000000000000000000000002';
const meta = (extra = {}) => JSON.stringify({ chirpyRoom: 1, namespace: PERSONAL_ORG.namespace, gate: { combine: 'any', rules: [] }, ...extra });
function setup() {
  const provider = { request: vi.fn().mockResolvedValue([self]) };
  const t = new XmtpTransport(PERSONAL_ORG, { address: self }, provider) as any;
  t.status = 'ready'; t.sdk = { ConsentState: { Unknown: 0, Allowed: 1, Denied: 2 }, ConversationType: { Group: 'group' }, IdentifierKind: { Ethereum: 0 } };
  const group = { consentState: vi.fn().mockResolvedValue(1), id: 'room', name: 'Room', description: meta(), sync: vi.fn(),
    isSuperAdmin: vi.fn().mockResolvedValue(true), isAdmin: vi.fn().mockResolvedValue(false),
    members: vi.fn().mockResolvedValue([{ inboxId: 'self' }]), addMembers: vi.fn().mockResolvedValue(undefined) };
  const stale = { ...group, description: meta(), sync: vi.fn() };
  const client = { inboxId: 'self', conversations: { getConversationById: vi.fn().mockResolvedValueOnce(stale).mockResolvedValue(group) },
    fetchInboxIdByIdentifier: vi.fn().mockResolvedValue('peer') };
  t.client = client; t.conversations.set('room', stale); t.roomMeta.set('room', JSON.parse(meta()));
  return { t, group, stale, client, provider };
}
it('syncs fresh metadata, resolves one activated inbox and adds it without changing gate/policy', async () => {
  const { t, group, stale, client, provider } = setup();
  await t.addRoomMember('room', ` ${peer} `);
  expect(stale.sync).toHaveBeenCalledTimes(1);
  expect(client.conversations.getConversationById).toHaveBeenCalledTimes(4);
  expect(provider.request).toHaveBeenCalledTimes(2);
  expect(client.fetchInboxIdByIdentifier).toHaveBeenCalledWith({ identifier: peer, identifierKind: 0 });
  expect(group.addMembers).toHaveBeenCalledExactlyOnceWith(['peer']);
  expect(t.dirtyConversations.has('room')).toBe(true);
});
it.each([
  ['future metadata', { chirpyRoom: 2 }], ['foreign namespace', { namespace: 'elsewhere' }],
  ['missing namespace', { namespace: undefined }], ['gated room', { gate: { combine: 'all', rules: [{ kind: 'ens', name: 'members.eth' }] } }],
  ['broken gate', { gate: null }],
])('ignores cached open-room authority and refuses %s', async (_, change) => {
  const { t, group } = setup(); group.description = meta(change);
  await expect(t.addRoomMember('room', peer)).rejects.toThrow();
  expect(group.addMembers).not.toHaveBeenCalled();
});
it.each(['missing', 'wrong-id', 'dm'])('refuses %s conversation lookups', async kind => {
  const { t, group, client } = setup();
  client.conversations.getConversationById.mockReset().mockResolvedValue(kind === 'missing' ? undefined : kind === 'wrong-id' ? { ...group, id: 'other' } : { id: 'room' });
  await expect(t.addRoomMember('room', peer)).rejects.toThrow('Room not found');
  expect(group.addMembers).not.toHaveBeenCalled();
});
it.each(['non-admin', 'removed', 'role-error', 'sync-error', 'members-error', 'unregistered', 'duplicate', 'same-inbox', 'wallet-switch', 'late-wallet-switch', 'disconnected'])('fails closed for %s', async kind => {
  const { t, group, stale, client, provider } = setup();
  if (kind === 'non-admin') group.isSuperAdmin.mockResolvedValue(false);
  if (kind === 'removed') group.members.mockResolvedValue([]);
  if (kind === 'role-error') { group.isSuperAdmin.mockRejectedValue(new Error('offline')); group.isAdmin.mockRejectedValue(new Error('offline')); }
  if (kind === 'sync-error') stale.sync.mockRejectedValue(new Error('offline'));
  if (kind === 'members-error') group.members.mockRejectedValue(new Error('offline'));
  if (kind === 'unregistered') client.fetchInboxIdByIdentifier.mockResolvedValue(undefined);
  if (kind === 'duplicate') group.members.mockResolvedValue([{ inboxId: 'self' }, { inboxId: 'peer' }]);
  if (kind === 'same-inbox') client.fetchInboxIdByIdentifier.mockResolvedValue('self');
  if (kind === 'wallet-switch') provider.request.mockResolvedValue([peer]);
  if (kind === 'late-wallet-switch') provider.request.mockResolvedValueOnce([self]).mockResolvedValue([peer]);
  if (kind === 'disconnected') provider.request.mockResolvedValue([]);
  await expect(t.addRoomMember('room', peer)).rejects.toThrow();
  expect(group.addMembers).not.toHaveBeenCalled();
});
it.each(['bad', self])('rejects invalid/self recipient %s before contacting the SDK', async target => {
  const { t, group, client } = setup();
  await expect(t.addRoomMember('room', target)).rejects.toThrow();
  expect(client.conversations.getConversationById).not.toHaveBeenCalled(); expect(group.addMembers).not.toHaveBeenCalled();
});
it('cancels a delayed request after its UI room/session changes and rejects duplicate dispatch', async () => {
  const { t, group, client } = setup(); let release!: (id: string) => void; let current = true;
  client.fetchInboxIdByIdentifier.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = t.addRoomMember('room', peer, () => current);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await expect(t.addRoomMember('room', peer)).rejects.toThrow('already in progress');
  current = false; release('peer'); await expect(pending).rejects.toThrow('changed');
  expect(group.addMembers).not.toHaveBeenCalled();
  client.fetchInboxIdByIdentifier.mockResolvedValue('peer'); await t.addRoomMember('room', peer);
  expect(group.addMembers).toHaveBeenCalledTimes(1);
});
it('preserves SDK failures and releases its pending lock without claiming success', async () => {
  const { t, group } = setup(); group.addMembers.mockRejectedValueOnce(new Error('Permission denied'));
  await expect(t.addRoomMember('room', peer)).rejects.toThrow('Permission denied');
  expect(t.dirtyConversations.size).toBe(0);
  await t.addRoomMember('room', peer); expect(group.addMembers).toHaveBeenCalledTimes(2);
});

it('rechecks a gate changed during recipient resolution before adding anyone', async () => {
  const { t, group, client } = setup();
  client.fetchInboxIdByIdentifier.mockImplementation(async () => {
    group.description = meta({ gate: { combine: 'all', rules: [{ kind: 'ens', name: 'members.eth' }] } });
    return 'peer';
  });
  await expect(t.addRoomMember('room', peer)).rejects.toThrow('Gated rooms');
  expect(group.addMembers).not.toHaveBeenCalled();
});

it('keeps the latest readable group preview when membership updates are newer', async () => {
  const { t, group } = setup();
  Object.assign(t.sdk, { ContentType: { Text: 'text', Reply: 'reply' }, SortDirection: { Descending: 'desc' },
    isText: message => message.content === 'last group text', isTextReply: () => false, isReply: () => false });
  const messages = vi.fn().mockResolvedValue([{ id: 'text', content: 'last group text', sentAtNs: 1000000n, senderInboxId: 'self', reactions: [] }]);
  const lastMessage = vi.fn().mockResolvedValue({ id: 'membership-update' });
  Object.assign(group, { messages, lastMessage }); t.addressesForMembers = async () => [self]; t.unreadCount = async () => 0;
  const mapped = await t.mapRoomConversation(group);
  expect(mapped.lastMessage).toMatchObject({ id: 'text', body: 'last group text' });
  expect(messages).toHaveBeenCalledExactlyOnceWith({ contentTypes: ['text', 'reply'], direction: 'desc', limit: 1n });
  expect(lastMessage).not.toHaveBeenCalled();
});

it('refuses a directory-managed room even when its SDK description says open', async () => {
  const { t, group } = setup();
  t.publishedRooms = vi.fn().mockResolvedValue([{ id: 'room' }]);
  await expect(t.addRoomMember('room', peer)).rejects.toThrow('gate service');
  expect(t.publishedRooms).toHaveBeenCalledExactlyOnceWith(true);
  expect(group.addMembers).not.toHaveBeenCalled();
});
it('does not override a previously observed published gate or an unavailable directory', async () => {
  const { t, group } = setup();
  t.roomMeta.set('room', { gate: { combine: 'all', rules: [{ kind: 'ens', name: 'members.eth' }] } });
  await expect(t.addRoomMember('room', peer)).rejects.toThrow('gate service');
  t.roomMeta.delete('room'); t.publishedRooms = vi.fn().mockRejectedValue(new Error('Directory unavailable'));
  await expect(t.addRoomMember('room', peer)).rejects.toThrow('Directory unavailable');
  expect(group.addMembers).not.toHaveBeenCalled();
});
it('bypasses a warm empty directory cache before a manual member addition', async () => {
  const { t, group } = setup();
  t.org = { ...PERSONAL_ORG, gateUrl: 'https://gate.example/catalog' };
  t.catalogCache = { at: Date.now(), rooms: [] };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ rooms: [{
    id: 'room', title: 'Managed room', namespace: PERSONAL_ORG.namespace,
    gate: { combine: 'all', rules: [{ kind: 'ens', name: 'members.eth' }] },
  }] }), { status: 200 }));
  try {
    await expect(t.addRoomMember('room', peer)).rejects.toThrow('gate service');
    expect(fetch).toHaveBeenCalledTimes(1); expect(group.addMembers).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
