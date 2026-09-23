/** Display-only identity resolution. Never use a resolved wallet as message authority. */
const MAX_IDS = 1000;
const CAPACITY = 2500;
const BATCH = 100;
const CONCURRENCY = 4;
const TTL = 30_000;
const MISS_TTL = 5_000;
const ETH = /^0x[a-fA-F0-9]{40}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

function wallet(state: Record<string, unknown>, ethereumKind: unknown): string | undefined {
  if (!Array.isArray(state.accountIdentifiers) || state.accountIdentifiers.length > 100) return;
  const address = (identifier: unknown) => record(identifier) && identifier.identifierKind === ethereumKind
    && typeof identifier.identifier === 'string' && ETH.test(identifier.identifier) ? identifier.identifier.toLowerCase() : undefined;
  const addresses = new Set(state.accountIdentifiers.map(address).filter((item): item is string => Boolean(item)));
  const recovery = address(state.recoveryIdentifier);
  // Prefer an active recovery wallet; otherwise display only an unambiguous Ethereum wallet.
  if (recovery && addresses.has(recovery)) return recovery;
  if (addresses.size === 1) return [...addresses][0];
}

export function inboxWallets(states: unknown, requested: readonly string[], ethereumKind: unknown): Map<string, string> {
  const found = new Map<string, string>();
  if (ethereumKind === undefined || ethereumKind === null || !Array.isArray(states) || states.length > requested.length) return found;
  const wanted = new Set(requested); const seen = new Set<string>(); const duplicate = new Set<string>();
  for (const state of states) {
    if (!record(state) || !validId(state.inboxId) || !wanted.has(state.inboxId)) continue;
    if (seen.has(state.inboxId)) { duplicate.add(state.inboxId); continue; }
    seen.add(state.inboxId);
    const address = wallet(state, ethereumKind);
    if (address) found.set(state.inboxId, address);
  }
  for (const id of duplicate) found.delete(id);
  return found;
}

/** Per-client, memory-only cache; bounds batching, parallelism, queued identities and lifetime. */
export class InboxIdentities {
  private cache = new Map<string, { at: number; address?: string }>();
  private pending = new Map<string, Promise<string | undefined>>();
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private fetchStates: (ids: string[]) => Promise<unknown>, private ethereumKind: unknown, private now = Date.now) {}

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.active++;
        void task().then(resolve, reject).finally(() => { this.active--; this.drain(); });
      });
      this.drain();
    });
  }
  private drain() { while (this.active < CONCURRENCY && this.queue.length) this.queue.shift()!(); }
  private async quick(request: Promise<Map<string, string>>): Promise<Map<string, string>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([request, new Promise<Map<string, string>>(resolve => {
        timer = setTimeout(() => resolve(new Map()), 8000);
      })]);
    } finally { clearTimeout(timer); }
  }

  async resolve(input: Iterable<string>): Promise<Map<string, string>> {
    const unique = new Set<string>();
    let scanned = 0;
    for (const id of input) { if (++scanned > 2000) break; if (validId(id)) unique.add(id); if (unique.size === MAX_IDS) break; }
    const ids = [...unique]; const reads = new Map<string, Promise<string | undefined>>(); const missing: string[] = [];
    const now = this.now();
    for (const id of ids) {
      const cached = this.cache.get(id);
      if (cached && now >= cached.at && now - cached.at < (cached.address ? TTL : MISS_TTL)) {
        this.cache.delete(id); this.cache.set(id, cached); reads.set(id, Promise.resolve(cached.address));
      } else {
        this.cache.delete(id);
        const pending = this.pending.get(id);
        if (pending) reads.set(id, pending);
        else if (this.pending.size + missing.length < CAPACITY) missing.push(id);
      }
    }
    for (let offset = 0; offset < missing.length; offset += BATCH) {
      const batch = missing.slice(offset, offset + BATCH);
      const request = this.schedule(async () => {
        try { return inboxWallets(await this.fetchStates(batch), batch, this.ethereumKind); }
        catch { return new Map<string, string>(); } // Failed lookup must not hide readable history or reuse expired identity.
      });
      // A slow lookup must not block history. Keep its underlying work in the same
      // bounded slot, and retain the settled fallback so polling cannot multiply requests.
      const quick = this.quick(request);
      for (const id of batch) {
        const result = quick.then(addresses => addresses.get(id));
        this.pending.set(id, result); reads.set(id, result);
        void request.then(addresses => {
          this.cache.delete(id); this.cache.set(id, { at: this.now(), address: addresses.get(id) });
          while (this.cache.size > CAPACITY) this.cache.delete(this.cache.keys().next().value!);
          if (this.pending.get(id) === result) this.pending.delete(id);
        });
      }
    }
    const result = new Map<string, string>();
    await Promise.all([...reads].map(async ([id, read]) => { const address = await read; if (address) result.set(id, address); }));
    return result;
  }
}

/** Prioritize visible authors, then a bounded number of reaction senders. */
export function messageInboxIds(messages: readonly { senderInboxId: string; reactions?: readonly { senderInboxId: string }[] }[]): string[] {
  const ids = new Set<string>();
  for (const message of messages.slice(0, MAX_IDS)) if (validId(message.senderInboxId)) ids.add(message.senderInboxId);
  let scanned = 0;
  for (const message of messages) for (const reaction of message.reactions ?? []) {
    if (++scanned > 2000 || ids.size >= MAX_IDS) return [...ids];
    if (validId(reaction.senderInboxId)) ids.add(reaction.senderInboxId);
  }
  return [...ids];
}
