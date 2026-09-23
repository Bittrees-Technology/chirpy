import { afterEach, expect, it, vi } from 'vitest';
import { DisplayWalletChoices } from '../src/displayWalletChoices';
import { InboxIdentities, linkedInboxWallets } from '../src/inboxIdentities';
import type { DisplayWalletRecord } from '../../core/src/displayWallet';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const a = addr(1), b = addr(2), foreign = addr(3), inbox = 'a'.repeat(64);
const empty = (wallet: string): DisplayWalletRecord => ({ version: 1, wallet, network: 'dev', inboxId: null, displayWallet: null, revision: 0, updatedAt: 0 });
const choice = (wallet = a): DisplayWalletRecord => ({ ...empty(wallet), inboxId: inbox, displayWallet: b, revision: 1, updatedAt: 1 });
const identifier = (identifier: string) => ({ identifier, identifierKind: 0 });
const state = (wallets = [a, b]) => ({ inboxId: inbox, accountIdentifiers: wallets.map(identifier), recoveryIdentifier: identifier(a) });
afterEach(() => vi.useRealTimers());
it('deduplicates lookups, separates networks and expires successful and failed reads', async () => {
  let now = 0; const read = vi.fn(async (_network, wallets) => wallets.map(empty));
  const choices = new DisplayWalletChoices(read, 'dev', () => now);
  expect((await choices.resolve([a, a, 'invalid'])).size).toBe(1);
  now = 29999; await choices.resolve([a]); expect(read).toHaveBeenCalledTimes(1);
  now = 30000; read.mockRejectedValueOnce(Error('offline')); expect((await choices.resolve([a])).size).toBe(0);
  now = 34999; await choices.resolve([a]); expect(read).toHaveBeenCalledTimes(2);
  now = 35000; expect((await choices.resolve([a])).size).toBe(1);
  expect((await new DisplayWalletChoices(read, 'production').resolve([a])).size).toBe(0);
  expect(read).toHaveBeenLastCalledWith('production', [a]);
});
it.each(['partial', 'duplicate', 'reordered', 'foreign', 'malformed'])('rejects the entire %s batch', async kind => {
  const records: any[] = [empty(a), empty(b)];
  if (kind === 'partial') records.pop(); if (kind === 'duplicate') records[1] = empty(a);
  if (kind === 'reordered') records.reverse(); if (kind === 'foreign') records[1] = empty(foreign);
  if (kind === 'malformed') records[1].unexpected = true;
  expect((await new DisplayWalletChoices(async () => records, 'dev').resolve([a, b])).size).toBe(0);
});
it('caps concurrency, batch size, total queued work and retained cache while sharing pending requests', async () => {
  vi.useFakeTimers(); const releases: Array<() => void> = [];
  const read = vi.fn((_network, wallets) => new Promise<DisplayWalletRecord[]>(resolve => {
    expect(wallets.length).toBeLessThanOrEqual(50); releases.push(() => resolve(wallets.map(empty)));
  }));
  const choices = new DisplayWalletChoices(read, 'dev');
  const full = choices.resolve(Array.from({ length: 3000 }, (_, i) => addr(i + 1)));
  const overlap = choices.resolve([a]); expect(read).toHaveBeenCalledTimes(4);
  expect((await choices.resolve([addr(4000)])).size).toBe(0);
  for (let i = 0; i < 50; i++) { expect(releases[i]).toBeTypeOf('function'); releases[i](); await vi.advanceTimersByTimeAsync(0); }
  expect((await full).size).toBe(2500); expect((await overlap).size).toBe(1); expect(read).toHaveBeenCalledTimes(50);
  read.mockImplementation(async (_network, wallets) => wallets.map(empty));
  await choices.resolve([addr(4000)]); await choices.resolve([a]); expect(read).toHaveBeenCalledTimes(52);
});
it('a display timeout keeps the pending slot and never multiplies polling or mutates returned fallback', async () => {
  vi.useFakeTimers(); let finish!: (records: DisplayWalletRecord[]) => void;
  const read = vi.fn(() => new Promise<DisplayWalletRecord[]>(resolve => { finish = resolve; }));
  const choices = new DisplayWalletChoices(read, 'dev'), pending = choices.resolve([a]);
  await vi.advanceTimersByTimeAsync(2000); const fallback = await pending; expect(fallback.size).toBe(0);
  for (let i = 0; i < 20; i++) expect((await choices.resolve([a])).size).toBe(0);
  expect(read).toHaveBeenCalledTimes(1); finish([choice()]); await vi.advanceTimersByTimeAsync(0);
  expect((await choices.resolve([a])).get(a)).toEqual(choice()); expect(fallback.size).toBe(0);
});
it('uses only current SDK links, expires choices after unlink and never trusts an API inbox claim', async () => {
  let now = 0; const fetchStates = vi.fn(async () => [state()]);
  const read = vi.fn(async (_network, wallets) => wallets.map(wallet => wallet === a ? choice() : empty(wallet)));
  const resolver = new InboxIdentities(fetchStates, 0, () => now, new DisplayWalletChoices(read, 'dev', () => now), 'dev');
  expect((await resolver.resolve([inbox])).get(inbox)).toBe(b);
  now = 30000; fetchStates.mockResolvedValue([state([a])]); expect((await resolver.resolve([inbox])).get(inbox)).toBe(a);
  now = 60000; fetchStates.mockResolvedValue([state([foreign])]); expect((await resolver.resolve([inbox])).get(inbox)).toBe(foreign);
  expect(read).toHaveBeenLastCalledWith('dev', [foreign]);
});
it('falls back to the verified default on incomplete or contradictory choices, and accepts explicit reset', async () => {
  for (const records of [[choice()], [choice(), { ...empty(b), revision: 1, updatedAt: 2, inboxId: inbox, displayWallet: null }]]) {
    const resolver = new InboxIdentities(async () => [state()], 0, Date.now, new DisplayWalletChoices(async () => records, 'dev'), 'dev');
    expect((await resolver.resolve([inbox])).get(inbox)).toBe(a);
  }
});
it('requires one bounded SDK record and filters invalid/non-Ethereum links', () => {
  expect(linkedInboxWallets([state()], inbox, 0)).toEqual([a, b]);
  for (const states of [null, [state(), state()], [{...state(), accountIdentifiers: null}], [state(Array(101).fill(a))]]) expect(linkedInboxWallets(states, inbox, 0)).toBeUndefined();
  expect(linkedInboxWallets([{...state(), accountIdentifiers: [identifier(a), identifier('bad'), {...identifier(b), identifierKind: 1}]}], inbox, 0)).toEqual([a]);
});
