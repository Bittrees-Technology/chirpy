export const MESSAGE_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1000;
interface TimedMessage { id: string; sentAtNs: bigint; }
export interface PageQuery { limit: bigint; sentBeforeNs?: bigint; }

/** XMTP's before filter is strict. Include every timestamp tie at the boundary. */
export async function readMessagePage<T extends TimedMessage>(fetch: (query: PageQuery) => Promise<T[]>, before?: string) {
  if (before !== undefined && !/^[0-9]{1,19}$/.test(before)) throw new Error('Invalid message history cursor.');
  const sentBeforeNs = before === undefined ? undefined : BigInt(before);
  let limit = MESSAGE_PAGE_SIZE + 1;
  for (;;) {
    const raw = (await fetch({ limit: BigInt(limit), sentBeforeNs })).sort((a, b) =>
      a.sentAtNs === b.sentAtNs ? b.id.localeCompare(a.id) : a.sentAtNs > b.sentAtNs ? -1 : 1);
    if (raw.length <= MESSAGE_PAGE_SIZE) return { messages: raw.reverse(), olderCursor: undefined };
    const boundary = raw[MESSAGE_PAGE_SIZE - 1].sentAtNs;
    // Expand only when the bounded query may have cut through a timestamp tie.
    if (raw.length === limit && raw.at(-1)!.sentAtNs === boundary && limit < MAX_PAGE_SIZE + 1) {
      limit = Math.min(MAX_PAGE_SIZE + 1, limit * 2 - 1); continue;
    }
    const selected = raw.filter(message => message.sentAtNs >= boundary);
    if (selected.length > MAX_PAGE_SIZE) throw new Error('Too many messages share one timestamp to display safely. Try a different conversation and report this history issue.');
    return { messages: selected.reverse(), olderCursor: raw.length > selected.length ? boundary.toString() : undefined };
  }
}
