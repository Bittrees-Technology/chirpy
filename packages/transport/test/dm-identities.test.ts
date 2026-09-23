import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';

const self = '0x0000000000000000000000000000000000000001';
const peer = '0x0000000000000000000000000000000000000002';
const state = (inboxId: string, address: string) => ({ inboxId, accountIdentifiers: [{ identifier: address, identifierKind: 0 }] });
function setup() {
  const t = new XmtpTransport(PERSONAL_ORG, { address: self }, null) as any;
  t.status = 'ready'; t.sdk = { IdentifierKind: { Ethereum: 0 } };
  const local = vi.fn().mockResolvedValue([]);
  const network = vi.fn().mockResolvedValue([state('peer', peer)]);
  const client = { inboxId: 'self', preferences: { getInboxStates: local, fetchInboxStates: network } };
  const dm = { id: 'dm', peerInboxId: vi.fn().mockResolvedValue('peer') };
  t.client = client; t.peerByConversation.clear();
  return { t, local, network, client, dm };
}
it('resolves a recovered peer over the network when local identity state throws', async () => {
  const f = setup(); f.local.mockRejectedValue(new Error('Inbox not found'));
  expect(await f.t.resolvePeer(f.dm)).toBe(peer);
  expect(f.network).toHaveBeenCalledExactlyOnceWith(['peer']);
});
it('does not accept a positional identity belonging to a different inbox', async () => {
  const f = setup(); f.local.mockResolvedValue([state('self', self)]);
  expect(await f.t.resolvePeer(f.dm)).toBe(peer);
  expect(f.t.peerByConversation.get('dm')).toBe(peer);
});
it('uses a matching local identity without a network lookup', async () => {
  const f = setup(); f.local.mockResolvedValue([state('peer', peer)]);
  expect(await f.t.resolvePeer(f.dm)).toBe(peer);
  expect(f.network).not.toHaveBeenCalled();
});
it('does not invent or cache a peer when both sources are unavailable', async () => {
  const f = setup(); f.local.mockRejectedValue(new Error('missing')); f.network.mockRejectedValue(new Error('offline'));
  expect(await f.t.resolvePeer(f.dm)).toBeUndefined();
  expect(f.t.peerByConversation.has('dm')).toBe(false);
});
it('discards an old client identity lookup after the wallet changes', async () => {
  const f = setup(); let finish!: (states: unknown[]) => void;
  f.network.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const result = f.t.resolvePeer(f.dm);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.t.client = { ...f.client };
  finish([state('peer', peer)]);
  expect(await result).toBeUndefined();
  expect(f.t.peerByConversation.has('dm')).toBe(false);
});
