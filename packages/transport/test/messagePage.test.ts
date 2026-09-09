import { expect, it, vi } from 'vitest';
import { readMessagePage } from '../src/messagePage';
const source = (rows: { id: string; sentAtNs: bigint }[]) => vi.fn(async ({ limit, sentBeforeNs }) => rows
  .filter(row => sentBeforeNs === undefined || row.sentAtNs < sentBeforeNs)
  .sort((a, b) => a.sentAtNs === b.sentAtNs ? b.id.localeCompare(a.id) : a.sentAtNs > b.sentAtNs ? -1 : 1)
  .slice(0, Number(limit)));
it('reads bounded pages from a 100,000-message history without losing nanosecond precision', async () => {
  const start = 1788943000000000000n;
  const fetch = source(Array.from({ length: 100000 }, (_, i) => ({ id: `${i}`, sentAtNs: start + BigInt(i) })));
  const latest = await readMessagePage(fetch);
  expect(latest.messages).toHaveLength(50); expect(latest.messages[0].id).toBe('99950');
  expect(fetch).toHaveBeenCalledWith({ limit: 51n, sentBeforeNs: undefined });
  const older = await readMessagePage(fetch, latest.olderCursor);
  expect(older.messages).toHaveLength(50); expect(older.messages.at(-1)?.id).toBe('99949');
  expect(new Set([...latest.messages, ...older.messages].map(row => row.id)).size).toBe(100);
});
it('keeps all timestamp ties at the page boundary and reaches the remaining older messages', async () => {
  const rows = [...Array.from({ length: 30 }, (_, i) => ({ id: `new${i}`, sentAtNs: 1000n + BigInt(i) })),
    ...Array.from({ length: 80 }, (_, i) => ({ id: `tie${i}`, sentAtNs: 900n })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `old${i}`, sentAtNs: 800n + BigInt(i) }))];
  const fetch = source(rows); const page = await readMessagePage(fetch);
  expect(page.messages).toHaveLength(110); expect(page.olderCursor).toBe('900');
  const older = await readMessagePage(fetch, page.olderCursor);
  expect(older.messages).toHaveLength(10); expect(older.olderCursor).toBeUndefined();
  expect(new Set([...page.messages, ...older.messages].map(row => row.id)).size).toBe(120);
});
it('rejects pathological timestamp floods without an unbounded query or silently dropping messages', async () => {
  const fetch = source(Array.from({ length: 1500 }, (_, i) => ({ id: `${i}`, sentAtNs: 900n })));
  await expect(readMessagePage(fetch)).rejects.toThrow('Too many messages');
  expect(fetch.mock.calls.every(([query]) => query.limit <= 1001n)).toBe(true);
  await expect(readMessagePage(fetch, '-2')).rejects.toThrow('Invalid');
});

import { XmtpTransport } from '../src/xmtp';
import { PERSONAL_ORG } from '@app/core';
it('uses typed SDK pages, bounds reply metadata and toggles a reaction by message ID in old history', async () => {
  const address = '0x0000000000000000000000000000000000000001';
  const t = new XmtpTransport(PERSONAL_ORG, { address }, null) as any;
  t.status = 'ready';
  t.sdk = { ConsentState: { Allowed: 1, Denied: 2 }, ConversationType: { Group: 'group' }, SortDirection: { Descending: 'desc' }, ContentType: { Text: 13, Reply: 12 },
    isText: () => true, isTextReply: () => false, isReply: () => false, ReactionAction: { Added: 1, Removed: 2 }, ReactionSchema: { Unicode: 1 } };
  t.addressForInbox = () => address;
  const messages = vi.fn(async () => [{ id: 'old', conversationId: 'dm', sentAtNs: 90n, senderInboxId: 'self', content: 'older message' }]);
  const conversation = { id: 'dm', consentState: async () => 1, sync: vi.fn(), messages, sendReaction: vi.fn() };
  t.conversations.set('dm', conversation);
  for (let i = 0; i < 3000; i++) { t.messageCursors.set(`cached${i}`, { conversationId: 'dm', at: 1n }); t.senderInboxByMessage.set(`cached${i}`, 'self'); }
  const page = await t.listMessagePage('dm', '100');
  expect(page.messages[0].id).toBe('old');
  expect(messages).toHaveBeenCalledWith({ limit: 51n, sentBeforeNs: 100n, direction: 'desc', contentTypes: [13, 12] });
  expect(t.messageCursors.size).toBe(2500); expect(t.senderInboxByMessage.size).toBe(2500);
  expect(t.messageCursors.has('old')).toBe(true);
  const getMessageById = vi.fn().mockResolvedValue({ id: 'old', conversationId: 'dm', reactions: [{ senderInboxId: 'self', sentAtNs: 91n, content: { content: '👍', action: 1 } }] });
  t.client = { conversations: { getMessageById } };
  await t.react('dm', 'old', '👍');
  expect(conversation.sendReaction).toHaveBeenCalledWith(expect.objectContaining({ reference: 'old', action: 2 }));
  expect(messages).toHaveBeenCalledTimes(1);
  getMessageById.mockResolvedValue({ id: 'old', conversationId: 'different' });
  await expect(t.react('dm', 'old', '👍')).rejects.toThrow('no longer available');
  expect(conversation.sendReaction).toHaveBeenCalledTimes(1);
});
