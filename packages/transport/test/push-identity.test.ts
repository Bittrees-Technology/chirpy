import { expect, it } from 'vitest';
import { parsePushIdentity, pushSenderIdentity } from '../src/pushIdentity';
const address = '0x' + 'A'.repeat(40);
const nft = `nft:eip155:1:${address.toLowerCase()}:12`;
it('preserves chain-qualified smart wallets and NFT ownership epochs without EOA aliases', () => {
  expect(parsePushIdentity(`scw:eip155:2:${address}`)).toBe(`scw:eip155:2:${address.toLowerCase()}`);
  expect(pushSenderIdentity(`${nft}:100`, nft)).toBe(`${nft}:100`);
  expect(pushSenderIdentity(nft, `${nft}:100`)).toBe(`${nft}:100`);
  expect(pushSenderIdentity(`${nft}:100`, `${nft}:101`)).toBeNull();
  expect(pushSenderIdentity(`scw:eip155:1:${address}`, address)).toBeNull();
  expect(pushSenderIdentity(`scw:eip155:1:${address}`, `scw:eip155:2:${address}`)).toBeNull();
});
it('bounds and validates protocol identifiers without accepting arbitrary display strings', () => {
  for (const value of ['javascript:alert(1)', `nft:eip155:1:${address}:1:owner`, `nft:eip155:1:${address}:${2n ** 256n}`, `scw:eip155:0:${address}`, `nft:eip155:1:${address}:1\n`, 'x'.repeat(257)]) expect(parsePushIdentity(value)).toBeNull();
});
