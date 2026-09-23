import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
const self = '0x0000000000000000000000000000000000000001';
const peer = '0x0000000000000000000000000000000000000002';
const former = '0x0000000000000000000000000000000000000003';
const state = (inboxId: string, address: string) => ({ inboxId, accountIdentifiers: [{ identifier: address, identifierKind: 0 }] });
function setup() {
  const t = new XmtpTransport(PERSONAL_ORG, { address: self }, null) as any;
  t.status = 'ready';
  t.sdk = { ConsentState: { Unknown: 0, Allowed: 1, Denied: 2 }, ConversationType: { Group: 'group' }, ContentType: { Text: 'text', Reply: 'reply' }, SortDirection: { Descending: 'desc' },
    IdentifierKind: { Ethereum: 0 }, ReactionAction: { Added: 'added', Removed: 'removed' }, ReactionSchema: { Unicode: 'unicode' },
    isText: message => typeof message.content === 'string', isTextReply: () => false, isReply: () => false };
  const reaction = { senderInboxId: 'former', sentAtNs: 3n, content: { content: '👍', action: 'added' } };
  const raw = ['member', 'former', 'unknown'].map((senderInboxId, i) => ({ id: `m${i}`, conversationId: 'room', senderInboxId, sentAtNs: BigInt(i + 1), content: `message ${i}`, reactions: i === 0 ? [reaction] : [] }));
  const fetch = vi.fn(async (ids: string[]) => ids.flatMap(id => id === 'member' ? [state(id, peer)] : id === 'former' ? [state(id, former)] : []).reverse());
  const client = { inboxId: 'self', preferences: { fetchInboxStates: fetch }, conversations: { getMessageById: vi.fn().mockResolvedValue(raw[0]) } };
  const group = { isActive: vi.fn().mockResolvedValue(true), consentState: vi.fn().mockResolvedValue(1), id: 'room', name: 'Room', sync: vi.fn(), messages: vi.fn().mockResolvedValue(raw), sendReaction: vi.fn(),
    members: vi.fn().mockResolvedValue([{ inboxId: 'self' }, { inboxId: 'member' }]), isSuperAdmin: async () => true };
  t.client = client; t.conversations.set('room', group); t.peerByConversation.set('room', 'wrong-DM-cache');
  t.roomMeta.set('room', { gate: { combine: 'any', rules: [] }, policy: { mode: 'active' } });
  return { t, client, fetch, group };
}
it('resolves current and departed authors/reactions, preserving unknown inbox identities and original reaction authority', async () => {
  const { t, group } = setup();
  const page = await t.listMessagePage('room');
  expect(page.messages.map(message => message.sender)).toEqual([peer, former, 'unknown']);
  expect(page.messages[0].reactions).toEqual({ '👍': [former] });
  expect(t.senderInboxByMessage.get('m0')).toBe('member');
  await t.react('room', 'm0', '👍');
  expect(group.sendReaction).toHaveBeenCalledWith({ reference: 'm0', referenceInboxId: 'member', action: 'added', content: '👍', schema: 'unicode' });
});
it('resolves roster records by inbox ID and shares that lookup with message history', async () => {
  const { t, fetch } = setup();
  expect(await t.addressesForMembers(t.conversations.get('room'))).toEqual([self, peer]);
  await t.listMessagePage('room');
  expect(fetch.mock.calls.map(call => call[0])).toEqual([['member'], ['former', 'unknown']]);
});
it('keeps readable messages and raw roster identities when the identity service is unavailable', async () => {
  const { t, fetch, group } = setup(); fetch.mockRejectedValue(new Error('offline'));
  expect((await t.listMessagePage('room')).messages.map(message => message.sender)).toEqual(['member', 'former', 'unknown']);
  expect(await t.addressesForMembers(group)).toEqual([self, 'member']);
});
it('rejects an old client lookup and does not reuse its cache for a replacement client', async () => {
  const { t, client, fetch } = setup(); let release!: (states: unknown[]) => void;
  fetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = t.listMessagePage('room');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  t.client = { ...client, preferences: { fetchInboxStates: vi.fn().mockResolvedValue([state('member', former)]) } };
  release([state('member', peer)]); await expect(pending).rejects.toThrow('Wallet changed');
  expect(t.senderInboxByMessage.has('m0')).toBe(false);
  expect((await t.listMessagePage('room')).messages[0].sender).toBe(former);
});

it('shares identity work across organization transports using the same SDK client', async () => {
  const first = setup(); const second = setup(); second.t.client = first.client;
  await first.t.listMessagePage('room'); await second.t.listMessagePage('room');
  expect(first.fetch).toHaveBeenCalledTimes(1); expect(second.fetch).not.toHaveBeenCalled();
});
