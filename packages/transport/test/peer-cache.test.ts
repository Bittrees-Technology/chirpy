import { afterEach, expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';

const a = '0x0000000000000000000000000000000000000001';
const b = '0x0000000000000000000000000000000000000002';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  return values;
}
function transport(self: string, other: string) {
  const t = new XmtpTransport(PERSONAL_ORG, { address: self }, null) as any;
  t.status = 'ready'; t.sdk = { IdentifierKind: { Ethereum: 0 } };
  t.client = { inboxId: self, preferences: { getInboxStates: vi.fn().mockResolvedValue([{ inboxId: 'peer', accountIdentifiers: [{ identifier: other, identifierKind: 0 }] }]) } };
  return t;
}
const dm = { id: 'shared-dm', peerInboxId: async () => 'peer' };
it('does not reuse the other participant as self when switching participating wallets', async () => {
  storage();
  expect(await transport(a, b).resolvePeer(dm)).toBe(b);
  expect(await transport(b, a).resolvePeer(dm)).toBe(a);
  const back = transport(a, b);
  expect(await back.resolvePeer(dm)).toBe(b);
  expect(back.client.preferences.getInboxStates).not.toHaveBeenCalled();
});
it('does not borrow an identity from a different environment cache', async () => {
  const values = storage();
  const current = transport(a, b);
  const otherEnv = current.peerCacheScope.startsWith('dev:') ? 'production' : 'dev';
  values.set(`chirpy.xmtp.peers.${otherEnv}:${a}`, JSON.stringify({ 'shared-dm': a }));
  const fresh = transport(a, b);
  expect(await fresh.resolvePeer(dm)).toBe(b);
  expect(fresh.client.preferences.getInboxStates).toHaveBeenCalledOnce();
});
it('ignores unscoped legacy entries without deleting them', async () => {
  const values = storage(); const legacy = JSON.stringify({ 'shared-dm': a }); values.set('chirpy.xmtp.peers', legacy);
  expect(await transport(a, b).resolvePeer(dm)).toBe(b);
  expect(values.get('chirpy.xmtp.peers')).toBe(legacy);
});

it.each(['null', '[]', '{broken', JSON.stringify({ 'shared-dm': 42 }), JSON.stringify({ 'shared-dm': 'not-a-wallet' }), ' '.repeat(1_000_001)])('ignores malformed or oversized cache input %#', async raw => {
  const values = storage(); const scope = transport(a, b).peerCacheScope;
  values.set(`chirpy.xmtp.peers.${scope}`, raw);
  expect(await transport(a, b).resolvePeer(dm)).toBe(b);
});
it('bounds loaded and subsequently persisted peer caches', async () => {
  const values = storage(); const scope = transport(a, b).peerCacheScope;
  values.set(`chirpy.xmtp.peers.${scope}`, JSON.stringify(Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`dm-${i}`, b]))));
  const t = transport(a, b);
  expect(t.peerByConversation.size).toBe(2500);
  await t.resolvePeer(dm);
  expect(t.peerByConversation.size).toBe(2500);
  expect(Object.keys(JSON.parse(values.get(`chirpy.xmtp.peers.${scope}`)!))).toHaveLength(2500);
});
it('continues messaging when browser cache reads or writes are denied', async () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
  expect(await transport(a, b).resolvePeer(dm)).toBe(b);
});
