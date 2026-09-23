import { expect, it, vi } from 'vitest';
import { InboxIdentities, inboxWallets, messageInboxIds } from '../src/inboxIdentities';
const a = '0x0000000000000000000000000000000000000001';
const b = '0x0000000000000000000000000000000000000002';
const identifier = (address: string, kind = 0) => ({ identifier: address, identifierKind: kind });
const state = (id: string, address = a) => ({ inboxId: id, accountIdentifiers: [identifier(address)], recoveryIdentifier: identifier(address) });
it('matches unordered responses by explicit inbox ID and ignores unrelated records', () => {
  expect(inboxWallets([state('B', b), state('A')], ['A', 'B'], 0)).toEqual(new Map([['B', b], ['A', a]]));
  expect(inboxWallets([state('foreign')], ['A'], 0).size).toBe(0);
  expect(inboxWallets([{ ...state('A'), inboxId: undefined }], ['A'], 0).size).toBe(0);
});
it('rejects duplicate, oversized and malformed response identities', () => {
  expect(inboxWallets([state('A'), state('A', b)], ['A', 'B'], 0).size).toBe(0);
  for (const response of [null, {}, [state('A'), state('B')], [{ ...state('A'), accountIdentifiers: null }], [{ ...state('A'), accountIdentifiers: [identifier(a, 1)] }]]) {
    expect(inboxWallets(response, ['A'], 0).size).toBe(0);
  }
});
it('uses only an active recovery wallet or a single unambiguous Ethereum identifier', () => {
  expect(inboxWallets([{ ...state('A'), accountIdentifiers: [identifier(a), identifier(b)], recoveryIdentifier: identifier(b) }], ['A'], 0).get('A')).toBe(b);
  expect(inboxWallets([{ ...state('A'), accountIdentifiers: [identifier(a), identifier(b)], recoveryIdentifier: identifier('not-wallet', 1) }], ['A'], 0).size).toBe(0);
  expect(inboxWallets([{ ...state('A'), accountIdentifiers: [identifier(b)] }], ['A'], 0).get('A')).toBe(b);
  expect(inboxWallets([{ ...state('A'), accountIdentifiers: [identifier('0Xbad')] }], ['A'], 0).size).toBe(0);
});
it('expires cached wallets, drops stale labels on lookup failure and retries bounded negative results', async () => {
  let now = 0; const fetch = vi.fn().mockResolvedValue([state('A')]); const resolver = new InboxIdentities(fetch, 0, () => now);
  expect((await resolver.resolve(['A'])).get('A')).toBe(a);
  now = 29999; expect((await resolver.resolve(['A'])).get('A')).toBe(a); expect(fetch).toHaveBeenCalledTimes(1);
  now = 30000; fetch.mockRejectedValueOnce(new Error('offline'));
  expect((await resolver.resolve(['A'])).size).toBe(0);
  now = 34999; expect((await resolver.resolve(['A'])).size).toBe(0); expect(fetch).toHaveBeenCalledTimes(2);
  now = 35000; fetch.mockResolvedValue([state('A', b)]);
  expect((await resolver.resolve(['A'])).get('A')).toBe(b);
  now = 1; fetch.mockResolvedValue([]); expect((await resolver.resolve(['A'])).size).toBe(0);
});
it('shares overlapping lookups and caps batches and concurrent network work', async () => {
  const releases: Array<() => void> = []; let active = 0; let peak = 0;
  const fetch = vi.fn((ids: string[]) => new Promise<unknown>(resolve => {
    active++; peak = Math.max(peak, active); expect(ids.length).toBeLessThanOrEqual(100);
    releases.push(() => { active--; resolve(ids.map(id => state(id))); });
  }));
  const resolver = new InboxIdentities(fetch, 0);
  const first = resolver.resolve(Array.from({ length: 1000 }, (_, i) => `id${i}`));
  const same = resolver.resolve(['id1', 'id2']);
  expect(fetch).toHaveBeenCalledTimes(4);
  for (let i = 0; i < 10; i++) { await vi.waitFor(() => expect(releases[i]).toBeTypeOf('function')); releases[i](); }
  expect((await first).size).toBe(1000); expect((await same).size).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(10); expect(peak).toBe(4);
});
it('bounds total queued identities and evicts the oldest cached entries', async () => {
  const releases: Array<() => void> = [];
  const fetch = vi.fn((ids: string[]) => new Promise<unknown>(resolve => releases.push(() => resolve(ids.map(id => state(id))))));
  const resolver = new InboxIdentities(fetch, 0);
  const requests = [0, 1000, 2000, 3000].map(start => resolver.resolve(Array.from({ length: 1000 }, (_, i) => `id${start + i}`)));
  expect((await requests[3]).size).toBe(0);
  for (let i = 0; i < 25; i++) { await vi.waitFor(() => expect(releases[i]).toBeTypeOf('function')); releases[i](); }
  const results = await Promise.all(requests); expect(results.map(result => result.size)).toEqual([1000, 1000, 500, 0]);
  fetch.mockImplementation(async ids => ids.map(id => state(id)));
  await resolver.resolve(['next']); await resolver.resolve(['id0']); expect(fetch).toHaveBeenCalledTimes(27);
});
it('prioritizes authors and bounds reaction identity collection without modifying original messages', () => {
  const messages = [{ senderInboxId: 'author', reactions: Array.from({ length: 3000 }, (_, i) => ({ senderInboxId: `r${i}` })) }, { senderInboxId: 'other' }];
  const ids = messageInboxIds(messages); expect(ids.slice(0, 2)).toEqual(['author', 'other']); expect(ids.length).toBe(1000);
  expect(messages[0].reactions!.length).toBe(3000);
});

it('returns raw-identity fallback after a slow lookup without freeing its network slot or multiplying polls', async () => {
  vi.useFakeTimers();
  try {
    let release!: (states: unknown[]) => void;
    const fetch = vi.fn(() => new Promise<unknown>(resolve => { release = resolve; }));
    const resolver = new InboxIdentities(fetch, 0);
    const pending = resolver.resolve(['A']);
    await vi.advanceTimersByTimeAsync(8000);
    const fallback = await pending; expect(fallback.size).toBe(0);
    for (let i = 0; i < 20; i++) expect((await resolver.resolve(['A'])).size).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    release([state('A')]); await vi.advanceTimersByTimeAsync(0);
    expect((await resolver.resolve(['A'])).get('A')).toBe(a);
    expect(fallback.size).toBe(0);
  } finally { vi.useRealTimers(); }
});
