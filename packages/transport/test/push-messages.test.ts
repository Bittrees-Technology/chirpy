import { describe, expect, it } from 'vitest';
import { readPushHistory, PUSH_HISTORY_LIMIT } from '../src/pushMessages';
import { pushConversationId } from '../src/pushRegistry';
const group = 'a'.repeat(64); const conversation = pushConversationId('governance', group);
const alice = `0x${'1'.repeat(40)}`; const bob = `0x${'2'.repeat(40)}`;
const message = (id: string, link: string | null, body = 'hello') => ({ cid: id, link, fromDID: `eip155:${alice}`, fromCAIP10: `eip155:${alice}`, toDID: group, toCAIP10: group, timestamp: 1000, messageType: 'Text', messageObj: { content: body }, messageContent: body });
const first = 'QmFirstMessage'; const second = 'QmSecondMessage'; const third = 'QmThirdMessage';
describe('Push history boundary', () => {
  it('uses linked history order despite clock ties and preserves the next reference', () => {
    const page = readPushHistory([message(first, second), message(second, third)], conversation);
    expect(page.messages.map(m => m.id)).toEqual([second, first]); expect(page.nextReference).toBe(third);
    expect(page.messages[0]).toMatchObject({ sender: alice, conversationId: conversation });
  });
  it('accepts a shuffled page and exact duplicates without duplicated messages', () => {
    expect(readPushHistory([message(second, null), message(first, second), message(second, null)], conversation).messages.map(m => m.id)).toEqual([second, first]);
  });
  it('rejects conflicting duplicates and branched, disconnected or cyclic history', () => {
    for (const rows of [[message(first, null), message(first, null, 'changed')], [message(first, third), message(second, third)],
      [message(first, second), message(second, first)], [message(first, first)], [message(first, null), message(second, null)]]) {
      expect(() => readPushHistory(rows, conversation)).toThrow('No messages were replaced');
    }
  });
  it('binds history and continuation to the original room and requested CID', () => {
    expect(() => readPushHistory([{ ...message(first, null), toDID: 'b'.repeat(64) }], conversation)).toThrow();
    expect(() => readPushHistory([{ ...message(first, null), toCAIP10: 'b'.repeat(64) }], conversation)).toThrow();
    expect(() => readPushHistory([message(first, null)], conversation, second)).toThrow();
    expect(() => readPushHistory([message(first, null)], 'raw-xmtp-id')).toThrow();
  });
  it('does not turn a missing referenced message into successful end-of-history', () => {
    expect(readPushHistory([], conversation)).toEqual({ messages: [] });
    expect(() => readPushHistory([], conversation, first)).toThrow('unsupported room history');
  });
  it('preserves legacy NFT epochs and smart-wallet chain identities in room history', () => {
    const nft = `nft:eip155:1:${alice}:42`;
    expect(readPushHistory([{ ...message(first, null), fromDID: `${nft}:100`, fromCAIP10: nft }], conversation).messages[0].sender).toBe(`${nft}:100`);
    const smart = `scw:eip155:10:${alice}`;
    expect(readPushHistory([{ ...message(first, null), fromDID: smart, fromCAIP10: smart }], conversation).messages[0].sender).toBe(smart);
    expect(() => readPushHistory([{ ...message(first, null), fromDID: `${nft}:100`, fromCAIP10: `${nft}:200` }], conversation)).toThrow();
  });
  it('rejects unsupported identities and sender mismatches', () => {
    for (const fromDID of [`eip155:${bob}`, 'eip155:nft:unknown', 'javascript:alert(1)', 'not-an-address']) {
      expect(() => readPushHistory([{ ...message(first, null), fromDID }], conversation)).toThrow();
    }
  });
  it('preserves visible placeholders for unsupported, undecryptable and oversized messages', () => {
    expect(readPushHistory([{ ...message(first, null), messageType: 'Image' }], conversation).messages[0].body).toContain('invalid');
    expect(readPushHistory([{ ...message(first, null), messageContent: 'Unable to Decrypt Message' }], conversation).messages[0].body).toContain('could not be decrypted');
    expect(readPushHistory([message(first, null, 'x'.repeat(16_001))], conversation).messages[0].body).toContain('too large');
  });
  it('rejects oversized arrays, missing timestamps, malformed links and IDs', () => {
    for (const rows of [Array(PUSH_HISTORY_LIMIT + 1).fill(message(first, null)), [{ ...message(first, null), timestamp: NaN }],
      [{ ...message(first, null), timestamp: undefined }], [{ ...message(first, null), cid: '../other' }], [{ ...message(first, null), link: undefined }]]) {
      expect(() => readPushHistory(rows, conversation)).toThrow();
    }
  });
  it('returns empty only for an actual valid empty page', () => {
    expect(readPushHistory([], conversation)).toEqual({ messages: [] });
    expect(() => readPushHistory({}, conversation)).toThrow();
  });
});
