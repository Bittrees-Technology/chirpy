import type { ChatMessage, PushMessagePart } from './types.js';
import { readPushAttachment, readPushMediaLink } from './pushMedia.js';
const MAX_BODY = 16_000, MAX_PARTS = 8;
const simpleTypes = ['Text', 'Image', 'File', 'Audio', 'Video', 'MediaEmbed'];
const unsupported = () => ({ body: 'This Push message type is not supported in Chat yet.' });
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function part(type: unknown, content: unknown): PushMessagePart {
  if (['Image', 'File', 'Audio', 'Video'].includes(type as string)) {
    const pushAttachment = readPushAttachment(type, content);
    return pushAttachment ? { body: pushAttachment.filename, pushAttachment } : { body: 'This Push attachment is invalid or exceeds the 1 MB download limit.' };
  }
  if (type === 'MediaEmbed' || type === 'GIF') {
    const pushMediaUrl = readPushMediaLink(content);
    return pushMediaUrl ? { body: pushMediaUrl, pushMediaUrl } : { body: 'This Push media link is not supported in Chat.' };
  }
  if (type !== 'Text') return unsupported();
  if (typeof content !== 'string') throw new Error('Invalid Push text content.');
  return { body: content.length > MAX_BODY ? 'This Push message is too large to display in Chat.' : content };
}
/** Stored SDK wire form, not the differently shaped send() input. No nested envelopes. */
function wirePart(value: unknown): PushMessagePart | undefined {
  const wire = record(value), inner = record(wire?.messageObj);
  if (!wire || !exact(wire, ['messageType', 'messageObj']) || !simpleTypes.includes(wire.messageType as string)
    || !inner || !exact(inner, ['content']) || typeof inner.content !== 'string') return;
  return part(wire.messageType, inner.content);
}
export function readPushContent(row: Record<string, unknown>, id: string): Pick<ChatMessage, 'body' | 'pushAttachment' | 'pushMediaUrl' | 'pushParts' | 'replyTo'> {
  if (row.messageContent === 'Unable to Decrypt Message' || row.messageObj === 'Unable to Decrypt Message') return { body: 'This Push message could not be decrypted.' };
  const object = record(row.messageObj);
  if (row.messageType === 'Reply') {
    if (!object || !exact(object, ['content', 'reference']) || typeof object.reference !== 'string'
      || !/^[a-zA-Z0-9]{10,128}$/.test(object.reference) || object.reference === id) return unsupported();
    const content = wirePart(object.content);
    return content ? { ...content, replyTo: object.reference } : unsupported();
  }
  if (row.messageType === 'Composite') {
    if (!object || !exact(object, ['content']) || !Array.isArray(object.content) || !object.content.length || object.content.length > MAX_PARTS) return unsupported();
    const pushParts = Array.from(object.content, wirePart);
    if (pushParts.some(value => !value)) return unsupported();
    const parts = pushParts as PushMessagePart[];
    return { body: parts.map(value => value.body).join('\n'), pushParts: parts };
  }
  return part(row.messageType, object ? object.content : row.messageContent);
}
