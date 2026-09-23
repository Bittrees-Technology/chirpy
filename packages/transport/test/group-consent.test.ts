import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
const self = '0x0000000000000000000000000000000000000001';
const other = '0x0000000000000000000000000000000000000002';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup(initial = 0) {
  let consent = initial;
  const provider = { request: vi.fn().mockResolvedValue([self]) };
  const t = new XmtpTransport(PERSONAL_ORG, { address: self }, provider) as any;
  t.status = 'ready';
  t.sdk = { ConsentState: { Unknown: 0, Allowed: 1, Denied: 2 }, ConversationType: { Group: 'group' },
    ContentType: { Text: 'text', Reply: 'reply' }, SortDirection: { Descending: 'desc' }, IdentifierKind: { Ethereum: 0 },
    ReactionAction: { Added: 'added', Removed: 'removed' }, ReactionSchema: { Unicode: 'unicode' },
    isText: m => typeof m.content === 'string', isTextReply: () => false, isReply: () => false, encodeText: vi.fn(async s => s) };
  const raw = { id: 'm', conversationId: 'group', senderInboxId: 'peer', sentAtNs: 10n, content: 'private group message' };
  const group = { isActive: vi.fn().mockResolvedValue(true), id: 'group', name: 'Group', description: JSON.stringify({ chirpyRoom: 1, namespace: 'personal', gate: { combine: 'any', rules: [] } }),
    consentState: vi.fn(async () => consent), updateConsentState: vi.fn(async value => { consent = value; }),
    members: vi.fn().mockResolvedValue([{ inboxId: 'self' }, { inboxId: 'peer' }]),
    messages: vi.fn().mockResolvedValue([raw]), sync: vi.fn(), countMessages: vi.fn().mockResolvedValue(1n),
    isAdmin: vi.fn().mockResolvedValue(false), isSuperAdmin: vi.fn().mockResolvedValue(true),
    sendText: vi.fn().mockResolvedValue('sent'), sendReply: vi.fn().mockResolvedValue('sent'), sendReaction: vi.fn(), sendReadReceipt: vi.fn(),
    requestRemoval: vi.fn(), removeMembers: vi.fn(), updateDescription: vi.fn() };
  const client = { inboxId: 'self', preferences: { fetchInboxStates: vi.fn().mockResolvedValue([{ inboxId: 'peer', accountIdentifiers: [{ identifier: other, identifierKind: 0 }] }]) },
    conversations: { getMessageById: vi.fn().mockResolvedValue(raw), sync: vi.fn(), syncAll: vi.fn(), list: vi.fn().mockResolvedValue([group]) } };
  t.client = client; t.conversations.set('group', group);
  t.roomMeta.set('group', { gate: { combine: 'any', rules: [] }, policy: { mode: 'active' } });
  return { t, group, client, provider, setConsent: (v: number) => { consent = v; } };
}
it.each([0, 2, 99])('native group consent %s rejects sends, reactions and local reads', async consent => {
  const { t, group } = setup(consent); t.messageCursors.set('m', { conversationId: 'group', at: 10n });
  await expect(t.send('group', 'no')).rejects.toThrow('Accept or unblock');
  await expect(t.react('group', 'm', '👍')).rejects.toThrow('Accept or unblock');
  await t.markRead('group', { sendReceipt: true, throughMessageId: 'm' });
  expect(t.readState.get('group')).toBe(0n);
  expect(group.sendText).not.toHaveBeenCalled(); expect(group.sendReaction).not.toHaveBeenCalled(); expect(group.sendReadReceipt).not.toHaveBeenCalled();
});
it('shows invitations without accepting them and masks blocked metadata without fetching bodies or profiles', async () => {
  const { t, group, client, setConsent } = setup();
  expect(await t.mapRoomConversation(group)).toMatchObject({ pending: true, blocked: false, consentSupported: true, canAddMembers: false, lastMessage: { body: 'private group message' } });
  expect(group.updateConsentState).not.toHaveBeenCalled();
  group.messages.mockClear(); group.members.mockClear(); client.preferences.fetchInboxStates.mockClear(); setConsent(2);
  expect(await t.mapRoomConversation(group)).toMatchObject({ pending: false, blocked: true, peers: [], unread: 0, lastMessage: undefined, canAddMembers: false });
  expect(await t.listMessagePage('group')).toEqual({ messages: [], olderCursor: undefined });
  expect(group.messages).not.toHaveBeenCalled(); expect(group.members).not.toHaveBeenCalled(); expect(client.preferences.fetchInboxStates).not.toHaveBeenCalled();
});
it('persists explicit accept, block and unblock without changing membership, and groups never emit read receipts', async () => {
  const { t, group } = setup();
  await t.setConversationConsent('group', 'allowed'); await t.send('group', 'accepted');
  await t.listMessagePage('group'); await t.markRead('group', { sendReceipt: true, throughMessageId: 'm' });
  expect(t.readState.get('group')).toBe(10n); expect(group.sendReadReceipt).not.toHaveBeenCalled();
  await t.setConversationConsent('group', 'denied'); await expect(t.send('group', 'no')).rejects.toThrow();
  await t.setConversationConsent('group', 'allowed'); await t.send('group', 'back');
  expect(group.updateConsentState.mock.calls).toEqual([[1], [2], [1]]);
  expect(group.requestRemoval).not.toHaveBeenCalled(); expect(group.removeMembers).not.toHaveBeenCalled();
});
it.each(['sync', 'messages', 'identity'])('discards history when block completes during %s', async stage => {
  const { t, group, client } = setup(1); const gate = deferred<any>();
  if (stage === 'sync') group.sync.mockImplementationOnce(() => gate.promise);
  if (stage === 'messages') group.messages.mockImplementationOnce(() => gate.promise);
  if (stage === 'identity') client.preferences.fetchInboxStates.mockImplementationOnce(() => gate.promise);
  const pending = t.listMessagePage('group');
  await vi.waitFor(() => expect((stage === 'sync' ? group.sync : stage === 'messages' ? group.messages : client.preferences.fetchInboxStates)).toHaveBeenCalled());
  await t.setConversationConsent('group', 'denied');
  gate.resolve(stage === 'messages' ? [{ id: 'm', content: 'late secret', senderInboxId: 'peer', sentAtNs: 10n }] : []);
  expect(await pending).toEqual({ messages: [], olderCursor: undefined });
  expect(t.senderInboxByMessage.size).toBe(0); expect(t.messageCursors.size).toBe(0);
});
it('rechecks consent after a delayed preview query', async () => {
  const { t, group } = setup(1); const gate = deferred<any>(); group.messages.mockImplementationOnce(() => gate.promise);
  const pending = t.mapRoomConversation(group); await vi.waitFor(() => expect(group.messages).toHaveBeenCalled());
  await t.setConversationConsent('group', 'denied'); gate.resolve([{ id: 'm', content: 'late secret', senderInboxId: 'peer', sentAtNs: 10n }]);
  expect(await pending).toMatchObject({ blocked: true, peers: [], lastMessage: undefined, unread: 0 });
});
it.each(['send', 'reply', 'react'])('rechecks authority immediately before delayed %s dispatch', async action => {
  const { t, group, client } = setup(1); const gate = deferred<any>();
  t.senderInboxByMessage.set('m', 'peer');
  if (action === 'send') t.assertGateAllows = () => gate.promise;
  if (action === 'reply') t.sdk.encodeText.mockImplementationOnce(() => gate.promise);
  if (action === 'react') client.conversations.getMessageById.mockImplementationOnce(() => gate.promise);
  const pending = action === 'react' ? t.react('group', 'm', '👍') : t.send('group', 'no', action === 'reply' ? { replyTo: 'm' } : undefined);
  const rejected = expect(pending).rejects.toThrow('Accept or unblock');
  await vi.waitFor(() => {
    if (action === 'reply') expect(t.sdk.encodeText).toHaveBeenCalled();
    else if (action === 'react') expect(client.conversations.getMessageById).toHaveBeenCalled();
    else expect(group.consentState).toHaveBeenCalled();
  });
  await t.setConversationConsent('group', 'denied'); gate.resolve(action === 'react' ? { conversationId: 'group' } : 'encoded'); await rejected;
  expect(group.sendText).not.toHaveBeenCalled(); expect(group.sendReply).not.toHaveBeenCalled(); expect(group.sendReaction).not.toHaveBeenCalled();
});
it.each(['client', 'wallet', 'scope'])('rejects delayed consent updates after %s changes', async kind => {
  const { t, group, provider } = setup(); const gate = deferred<any>(); provider.request.mockImplementationOnce(() => gate.promise); let current = true;
  const pending = t.setConversationConsent('group', 'allowed', () => current); const rejected = expect(pending).rejects.toThrow('Wallet changed');
  await vi.waitFor(() => expect(provider.request).toHaveBeenCalled());
  if (kind === 'client') t.client = { inboxId: 'replacement' };
  if (kind === 'scope') current = false;
  gate.resolve([kind === 'wallet' ? other : self]); await rejected;
  expect(group.updateConsentState).not.toHaveBeenCalled();
});
it('rejects duplicate consent operations and sends while a change is pending; failures retain prior consent', async () => {
  const { t, group, provider } = setup(); const gate = deferred<any>(); provider.request.mockImplementationOnce(() => gate.promise);
  const pending = t.setConversationConsent('group', 'allowed'); await vi.waitFor(() => expect(provider.request).toHaveBeenCalled());
  await expect(t.setConversationConsent('group', 'denied')).rejects.toThrow('already in progress');
  await expect(t.send('group', 'no')).rejects.toThrow();
  group.updateConsentState.mockRejectedValueOnce(new Error('offline')); const rejected = expect(pending).rejects.toThrow('offline'); gate.resolve([self]); await rejected;
  expect((await t.mapRoomConversation(group)).pending).toBe(true);
  await t.setConversationConsent('group', 'allowed'); expect((await t.mapRoomConversation(group)).pending).toBe(false);
});
it('directory namespace overlays preserve existing blocked consent; unjoined catalog entries get no consent authority', async () => {
  const { t, group } = setup(2); t.org = { ...PERSONAL_ORG, namespace: 'org' };
  group.description = '{}';
  t.publishedRooms = async () => ['group', 'unjoined'].map(id => ({ id, kind: 'room', title: id, namespace: 'org', peers: [], unread: 0, gate: { combine: 'all', rules: [{ kind: 'ens' }] } }));
  const rooms = await t.listConversations();
  expect(rooms.find(c => c.id === 'group')).toMatchObject({ blocked: true, consentSupported: true, lastMessage: undefined });
  expect(rooms.find(c => c.id === 'unjoined').consentSupported).toBeUndefined();
  await expect(t.setConversationConsent('unjoined', 'allowed')).rejects.toThrow('Conversation not found');
});
it('fails closed if consent cannot be read', async () => {
  const { t, group } = setup(1); group.consentState.mockRejectedValue(new Error('consent unavailable'));
  await expect(t.mapRoomConversation(group)).rejects.toThrow('consent unavailable');
  await expect(t.listMessagePage('group')).rejects.toThrow('consent unavailable');
  await expect(t.send('group', 'no')).rejects.toThrow('consent unavailable');
  expect(group.messages).not.toHaveBeenCalled(); expect(group.sendText).not.toHaveBeenCalled();
});

it('does not publish a stale allowed snapshot held by a slow directory read after blocking', async () => {
  const { t, group } = setup(1); const directory = deferred<any>();
  t.publishedRooms = vi.fn().mockImplementationOnce(() => directory.promise).mockResolvedValue([]);
  const pending = t.listConversations();
  await vi.waitFor(() => expect(t.publishedRooms).toHaveBeenCalledOnce());
  await t.setConversationConsent('group', 'denied'); directory.resolve([]);
  expect((await pending)[0]).toMatchObject({ blocked: true, lastMessage: undefined, peers: [] });
  expect(t.publishedRooms).toHaveBeenCalledTimes(2);
  expect(group.updateConsentState).toHaveBeenCalledExactlyOnceWith(2);
});

it.each([0, 1, 2])('explicit room creation accepts only unknown consent and never overrides denied state %s', async initial => {
  const { t, group, client } = setup(initial);
  Object.assign(t.sdk, { GroupPermissionsOptions: { Default: 'default' } });
  Object.assign(client.conversations, { createGroup: vi.fn().mockResolvedValue(group) });
  Object.assign(group, { updateName: vi.fn(), addSuperAdmin: vi.fn().mockResolvedValue(undefined) });
  const created = t.createRoom({ title: 'New group', gate: { combine: 'any', rules: [] } });
  if (initial === 2) {
    await expect(created).rejects.toThrow('Accept or unblock'); expect(group.sendText).not.toHaveBeenCalled();
  } else {
    expect(await created).toMatchObject({ pending: false, blocked: false }); expect(group.sendText).toHaveBeenCalledOnce();
  }
  if (initial === 0) expect(group.updateConsentState).toHaveBeenCalledExactlyOnceWith(1);
  else expect(group.updateConsentState).not.toHaveBeenCalled();
});
it('blocked administrators cannot change the room policy', async () => {
  const { t, group } = setup(2);
  await expect(t.setRoomPolicy('group', { mode: 'read-only' })).rejects.toThrow('Accept or unblock');
  expect(group.updateDescription).not.toHaveBeenCalled();
});

it('explicitly includes denied groups in full and fallback SDK listing so they remain available to unblock', async () => {
  const { t, client, group } = setup(2);
  client.conversations.list.mockImplementation(async options => options?.consentStates?.includes(2) ? [group] : []);
  const [blocked] = await t.listConversations(); expect(blocked.blocked).toBe(true);
  expect(client.conversations.list).toHaveBeenCalledWith({ consentStates: [0, 1, 2] });
  await t.setConversationConsent('group', 'allowed');
  expect((await t.listConversations())[0]).toMatchObject({ blocked: false, pending: false });
});

it('reads restored inactive group history without network sync and refuses new actions', async () => {
  const { t, group } = setup(1); group.isActive.mockResolvedValue(false);
  group.sync.mockRejectedValue(new Error('Group is inactive'));
  expect((await t.listMessagePage('group')).messages[0].body).toBe('private group message');
  expect(group.sync).not.toHaveBeenCalled();
  expect(await t.mapRoomConversation(group)).toMatchObject({ deviceAccess: 'inactive', canAddMembers: false });
  await expect(t.send('group', 'no')).rejects.toThrow('Active access');
  await expect(t.react('group', 'm', '👍')).rejects.toThrow('Active access');
  await expect(t.setRoomPolicy('group', { mode: 'read-only' })).rejects.toThrow('Active access');
  expect(group.sendText).not.toHaveBeenCalled(); expect(group.sendReaction).not.toHaveBeenCalled(); expect(group.updateDescription).not.toHaveBeenCalled();
});
it('keeps local group history readable when device access cannot be confirmed, without granting actions', async () => {
  const { t, group } = setup(1); group.isActive.mockRejectedValue(new Error('access unavailable'));
  expect((await t.listMessagePage('group')).messages[0].body).toBe('private group message');
  expect(await t.mapRoomConversation(group)).toMatchObject({ deviceAccess: 'unavailable', canAddMembers: false });
  await expect(t.send('group', 'no')).rejects.toThrow('Active access');
  expect(group.sync).not.toHaveBeenCalled(); expect(group.sendText).not.toHaveBeenCalled();
});
it('preserves genuine network sync errors while allowing history after confirmed inactivity', async () => {
  const { t, group } = setup(1); group.sync.mockRejectedValue(new Error('network offline'));
  await expect(t.listMessagePage('group')).rejects.toThrow('network offline');
  group.isActive.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect((await t.listMessagePage('group')).messages[0].body).toBe('private group message');
});

it('rechecks device access before a delayed send is dispatched', async () => {
  const { t, group } = setup(1); const gate = deferred<void>();
  t.assertGateAllows = vi.fn(() => gate.promise);
  const pending = t.send('group', 'do not send after access changes');
  const rejected = expect(pending).rejects.toThrow('Active access');
  await vi.waitFor(() => expect(t.assertGateAllows).toHaveBeenCalled());
  group.isActive.mockResolvedValue(false); gate.resolve();
  await rejected;
  expect(group.sendText).not.toHaveBeenCalled();
});
