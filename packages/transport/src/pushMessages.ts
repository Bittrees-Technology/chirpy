import { pushSenderIdentity } from './pushIdentity.js';
import type { ChatMessage } from './types.js';
import { parsePushConversationId } from './pushRegistry.js';
import { readPushAttachment, readPushMediaLink } from './pushMedia.js';
export const PUSH_HISTORY_LIMIT = 30;
const MAX_BODY = 16_000;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_MEDIA_PAGE_BYTES = 8 * 1024 * 1024;
export interface PushHistoryPage { messages: ChatMessage[]; nextReference?: string }
function invalid(): never { throw new Error('Push returned an unsupported room history response. No messages were replaced.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function cid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9]{10,128}$/.test(value)) invalid();
  return value;
}
/** Only decrypted SDK results belong here; this function does not verify signatures.
 * Push's public plaintext path does not provide XMTP-equivalent sender verification. */
export function readPushHistory(raw: unknown, conversationId: string, requestedReference?: string): PushHistoryPage {
  const room = parsePushConversationId(conversationId);
  if (!room || !Array.isArray(raw) || raw.length > PUSH_HISTORY_LIMIT) invalid();
  if (requestedReference !== undefined) cid(requestedReference);
  const seen = new Map<string, { message: ChatMessage; link: string | null }>();
  let size = 0;
  let mediaSize = 0;
  for (const value of raw) {
    const row = object(value); const id = cid(row.cid);
    // Do not show another room's message even if a cursor or backend response is wrong.
    const recipients = [row.toDID, row.toCAIP10].filter(value => value !== undefined);
    if (!recipients.length || recipients.some(value => value !== room.chatId)) invalid();
    const from = pushSenderIdentity(row.fromDID, row.fromCAIP10);
    if (!from) invalid();
    if (typeof row.timestamp !== 'number' || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0 || row.timestamp > 8_640_000_000_000_000) invalid();
    const link = row.link === null ? null : cid(row.link);
    if (link === id) invalid();
    let body: string, pushAttachment: ChatMessage['pushAttachment'], pushMediaUrl: string | undefined;
    const messageObj = row.messageObj;
    const content = messageObj && typeof messageObj === 'object' && !Array.isArray(messageObj) ? (messageObj as Record<string, unknown>).content : row.messageContent;
    if (row.messageContent === 'Unable to Decrypt Message') body = 'This Push message could not be decrypted.';
    else if (['Image', 'File', 'Audio', 'Video'].includes(row.messageType as string)) {
      pushAttachment = readPushAttachment(row.messageType, content);
      body = pushAttachment ? pushAttachment.filename : 'This Push attachment is invalid or exceeds the 1 MB download limit.';
    }
    else if (row.messageType === 'MediaEmbed' || row.messageType === 'GIF') {
      pushMediaUrl = readPushMediaLink(content);
      body = pushMediaUrl ?? 'This Push media link is not supported in Chat.';
    }
    else if (row.messageType !== 'Text') body = 'This Push message type is not supported in Chat yet.';
    else {
      if (typeof content !== 'string') invalid();
      // Preserve an explicit placeholder for oversized legacy messages, without rendering them.
      body = content.length > MAX_BODY ? 'This Push message is too large to display in Chat.' : content;
    }
    size += new TextEncoder().encode(body).byteLength;
    if (size > MAX_PAGE_BYTES) invalid();
    const next = { message: { id, conversationId, sender: from, body, sentAt: row.timestamp, ...(pushAttachment ? { pushAttachment } : {}), ...(pushMediaUrl ? { pushMediaUrl } : {}) }, link };
    const previous = seen.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(next)) invalid();
    if (!previous) mediaSize += pushAttachment?.base64.length ?? 0;
    if (mediaSize > MAX_MEDIA_PAGE_BYTES) invalid();
    seen.set(id, next);
  }
  if (!seen.size) {
    // An issued reference names a real next message. An empty reply is a failed
    // continuation, not evidence that the room's history has ended.
    if (requestedReference !== undefined) invalid();
    return { messages: [] };
  }
  // Follow protocol links rather than timestamps; clocks can be equal or skewed.
  const linked = new Set([...seen.values()].map(value => value.link).filter((id): id is string => id !== null && seen.has(id)));
  const heads = [...seen.keys()].filter(id => !linked.has(id));
  if (heads.length !== 1 || (requestedReference !== undefined && heads[0] !== requestedReference)) invalid();
  const ordered: ChatMessage[] = []; const visited = new Set<string>();
  let current: string | null = heads[0];
  while (current && seen.has(current)) {
    if (visited.has(current)) invalid();
    visited.add(current);
    const entry: { message: ChatMessage; link: string | null } = seen.get(current)!; ordered.push(entry.message); current = entry.link;
  }
  if (visited.size !== seen.size) invalid();
  return { messages: ordered.reverse(), ...(current ? { nextReference: current } : {}) };
}
