import { expect, it } from 'vitest';
import { displayWalletSignMessage, selectDisplayWallet, validDisplayWalletCommand, validDisplayWalletRecord } from '../src/displayWallet';
const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40), other = '0x' + '3'.repeat(40), inbox = 'a'.repeat(64);
const service = 'https://chat.example/api/profile?kind=display-wallet';
const record = (patch = {}) => ({ version: 1, wallet: a, network: 'dev', inboxId: inbox, displayWallet: b, revision: 1, updatedAt: 10, ...patch });
const empty = (wallet = b) => record({ wallet, inboxId: null, displayWallet: null, revision: 0, updatedAt: 0 });
const command = (patch = {}) => ({ version: 1, service, wallet: a, network: 'dev', inboxId: inbox, displayWallet: b, revision: 0, expiresAt: Date.now() + 60000, ...patch });
it('selects a currently linked display wallet only from a current linked author and matching inbox/network', () => {
  expect(selectDisplayWallet([record(), empty()], inbox, 'dev', [a, b])).toBe(b);
  expect(selectDisplayWallet([record({ inboxId: 'b'.repeat(64) }), empty()], inbox, 'dev', [a, b])).toBeUndefined();
  expect(selectDisplayWallet([record(), empty()], inbox, 'production', [a, b])).toBeUndefined();
  expect(selectDisplayWallet([record({ wallet: other }), empty()], inbox, 'dev', [a, b])).toBeUndefined();
  expect(selectDisplayWallet([empty()], inbox, 'dev', [b])).toBeUndefined();
});
it('honors the newest reset or invalidated target without resurrecting an older choice', () => {
  for (const displayWallet of [null, other]) {
    const records = [record(), record({ wallet: b, displayWallet, updatedAt: 20 })];
    expect(selectDisplayWallet(records, inbox, 'dev', [a, b])).toBeUndefined();
    expect(selectDisplayWallet(records.reverse(), inbox, 'dev', [b, a])).toBeUndefined();
  }
  expect(selectDisplayWallet([record({ displayWallet: other }), empty()], inbox, 'dev', [a, b])).toBeUndefined();
});
it('resolves concurrent linked-wallet choices consistently, without relying on response order', () => {
  const records = [record(), record({ wallet: b, displayWallet: a })];
  expect(selectDisplayWallet(records, inbox, 'dev', [a, b])).toBe(a);
  expect(selectDisplayWallet(records.reverse(), inbox, 'dev', [b, a])).toBe(a);
});
it.each([
  [record()], [record(), record()], [record(), empty(), empty()],
  [record(), null], [record(), { ...empty(), surprise: true }], [record(), { ...empty(), network: 'production' }],
])('fails closed on incomplete, duplicate, malformed or mixed-network responses: %j', records => {
  expect(selectDisplayWallet(records, inbox, 'dev', [a, b])).toBeUndefined();
});
it('bounds schemas, clocks, identifiers, networks and replay revisions', () => {
  expect(validDisplayWalletCommand(command(), service)).toBe(true);
  for (const patch of [{ service: 'https://other.example' }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 300001 }, { network: 'local' }, { inboxId: null }, { inboxId: 'bad' }, { wallet: 'bad' }, { displayWallet: '' }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER - 1 }, { extra: 'private' }]) expect(validDisplayWalletCommand(command(patch), service)).toBe(false);
  expect(validDisplayWalletRecord(empty(a), a, 'dev')).toBe(true);
  expect(validDisplayWalletRecord(record({ revision: Number.MAX_SAFE_INTEGER - 1 }), a, 'dev')).toBe(true);
  for (const patch of [{ revision: 0 }, { inboxId: null }, { updatedAt: 0 }, { updatedAt: Infinity }, { revision: Number.MAX_SAFE_INTEGER }, { displayWallet: '' }]) expect(validDisplayWalletRecord(record(patch), a, 'dev')).toBe(false);
});
it('binds every choice field and purpose into the signed message', () => {
  const current = command() as any, message = displayWalletSignMessage(current);
  for (const patch of [{ wallet: b }, { displayWallet: a }, { displayWallet: null }, { inboxId: 'b'.repeat(64) }, { network: 'production' }, { service: service + 'x' }, { revision: 1 }, { expiresAt: current.expiresAt + 1 }]) expect(displayWalletSignMessage({ ...current, ...patch } as any)).not.toBe(message);
  expect(message).toContain('association are public'); expect(message).toContain('does not link wallets');
});
