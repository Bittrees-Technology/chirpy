import type { ChatMessage } from './types.js';
/** Matches the pinned Push SDK's CHAT.REACTION validator. No remove operation. */
export const PUSH_REACTIONS = ['👍', '👎', '❤️', '👏', '😂', '😢', '😡', '😲', '🔥'] as const;
export type PushReactionEmoji = typeof PUSH_REACTIONS[number];
export interface PushReaction { reference: string; emoji: PushReactionEmoji }
export interface PushReactionEvent extends PushReaction { sender: string }
export function isPushReactionEmoji(value: unknown): value is PushReactionEmoji {
  return typeof value === 'string' && (PUSH_REACTIONS as readonly string[]).includes(value);
}
export function pushReactionEvents(messages: ChatMessage[]): PushReactionEvent[] {
  return messages.flatMap(message => message.pushReaction ? [{ ...message.pushReaction, sender: message.sender }] : []);
}
/** Newer pages plus the current linked page form one history snapshot. Older
 * events cannot react to newer messages; timestamps never establish ordering. */
export function withPushReactions(messages: ChatMessage[], newer: PushReactionEvent[]): ChatMessage[] {
  const byReference = new Map<string, Map<string, Set<string>>>();
  const add = ({ reference, emoji, sender }: PushReactionEvent) => {
    const reactions = byReference.get(reference) ?? new Map<string, Set<string>>();
    const senders = reactions.get(emoji) ?? new Set<string>();
    senders.add(sender); reactions.set(emoji, senders); byReference.set(reference, reactions);
  };
  newer.forEach(add);
  const result: ChatMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.pushReaction) { add({ ...message.pushReaction, sender: message.sender }); result.push(message); }
    else {
      const reactions = byReference.get(message.id);
      result.push(reactions ? { ...message, reactions: Object.fromEntries([...reactions].map(([emoji, senders]) => [emoji, [...senders].sort()])) } : message);
    }
  }
  return result.reverse();
}
