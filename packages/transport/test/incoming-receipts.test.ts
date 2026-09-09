import { expect, it, vi } from 'vitest';
import { XmtpTransport } from '../src/xmtp';
import { PERSONAL_ORG } from '@app/core';
function setup() {
  const transport = new XmtpTransport(PERSONAL_ORG, { address: '0x0000000000000000000000000000000000000001' }, null) as any;
  transport.status = 'ready'; transport.client = { inboxId: 'self' };
  transport.sdk = { ConsentState: { Allowed: 1 }, ConversationType: { Group: 'room' }, ContentType: { ReadReceipt: 10 }, SortDirection: { Descending: 1 }, isReadReceipt: (m) => m.type === 'receipt' };
  const receipt = { type: 'receipt', senderInboxId: 'peer', conversationId: 'dm', sentAtNs: 1_700_000_000_000_000_000n };
  const conversation = { id: 'dm', metadata: { conversationType: 'dm' }, consentState: vi.fn(async () => 1), peerInboxId: vi.fn(async () => 'peer'), messages: vi.fn(async () => [receipt]), lastReadTimes: vi.fn(async () => new Map([['peer', receipt.sentAtNs]])) };
  return { transport, conversation, receipt };
}
it('reads indexed peer receipt time without loading message history', async () => {
  const { transport, conversation } = setup();
  expect(await transport.peerReceiptTime(conversation)).toBe(1_700_000_000_000);
  expect(conversation.lastReadTimes).toHaveBeenCalledOnce();
  expect(conversation.messages).not.toHaveBeenCalled();
});
it.each([0, 2])('does not query receipts for consent state %s', async (state) => {
  const { transport, conversation } = setup(); conversation.consentState.mockResolvedValue(state);
  expect(await transport.peerReceiptTime(conversation)).toBeUndefined();
  expect(conversation.lastReadTimes).not.toHaveBeenCalled();
});
it.each([
  { sentAtNs: -1n }, { sentAtNs: 99_999_999_999_999_999_999n }, { sentAtNs: 'invalid' },
])('does not infer receipt evidence from invalid input %#', async (patch) => {
  const { transport, conversation, receipt } = setup(); Object.assign(receipt, patch);
  expect(await transport.peerReceiptTime(conversation)).toBeUndefined();
});
it('suppresses self-conversation, room and unavailable receipt evidence', async () => {
  const { transport, conversation } = setup();
  conversation.peerInboxId.mockResolvedValue('self');
  expect(await transport.peerReceiptTime(conversation)).toBeUndefined();
  expect(conversation.messages).not.toHaveBeenCalled();
  conversation.metadata.conversationType = 'room';
  expect(await transport.peerReceiptTime(conversation)).toBeUndefined();
  conversation.metadata.conversationType = 'dm'; conversation.peerInboxId.mockRejectedValue(new Error('offline'));
  expect(await transport.peerReceiptTime(conversation)).toBeUndefined();
});
it('keeps the text preview when the latest protocol event is a read receipt', async () => {
  const { transport, conversation, receipt } = setup();
  Object.assign(transport.sdk, { ContentType: { Text: 13, Reply: 12, ReadReceipt: 10 }, isText: (m) => m.type === 'text' });
  transport.resolvePeer = async () => 'peer'; transport.unreadCount = async () => 0;
  const message = { ...receipt, id: 'message', type: 'text', content: 'retained preview' };
  conversation.messages.mockImplementation(async (query: any) => query.contentTypes[0] === 13 ? [message] : [receipt]);
  expect(await transport.mapConversation(conversation)).toMatchObject({ lastMessage: { body: 'retained preview' }, lastReadReceiptAt: 1_700_000_000_000 });
});

it('does not borrow receipt times from self or an unrelated inbox', async () => {
  const { transport, conversation } = setup();
  conversation.lastReadTimes.mockResolvedValue(new Map([['self', 1700000000000000000n], ['stranger', 1700000000000000000n]]));
  expect(await transport.peerReceiptTime(conversation)).toBeUndefined();
  conversation.lastReadTimes.mockRejectedValue(new Error('offline'));
  expect(await transport.peerReceiptTime(conversation)).toBeUndefined();
});
