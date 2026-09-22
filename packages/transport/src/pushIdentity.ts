/** Canonical display identity only; this does not verify ownership or signatures.
 * NFT ownership epochs and smart-wallet chain IDs must never collapse into an EOA. */
export function parsePushIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256 || /\s/.test(value)) return null;
  const wallet = /^(?:eip155:(?:([0-9]{1,16}):)?)?(0x[a-fA-F0-9]{40})$/.exec(value);
  const chain = (text: string) => Number.isSafeInteger(Number(text)) && Number(text) > 0;
  if (wallet) return wallet[1] && !chain(wallet[1]) ? null : wallet[2].toLowerCase();
  const smart = /^scw:eip155:([0-9]{1,16}):(0x[a-fA-F0-9]{40})$/.exec(value);
  if (smart) return chain(smart[1]) ? `scw:eip155:${Number(smart[1])}:${smart[2].toLowerCase()}` : null;
  const nft = /^nft:eip155:([0-9]{1,16}):(0x[a-fA-F0-9]{40}):([0-9]{1,78})(?::([0-9]{1,16}))?$/i.exec(value);
  if (!nft || !chain(nft[1]) || BigInt(nft[3]) >= 2n ** 256n || (nft[4] !== undefined && !Number.isSafeInteger(Number(nft[4])))) return null;
  return `nft:eip155:${Number(nft[1])}:${nft[2].toLowerCase()}:${BigInt(nft[3])}${nft[4] === undefined ? '' : `:${Number(nft[4])}`}`;
}
export function pushSenderIdentity(did: unknown, caip: unknown): string | null {
  if (did !== undefined && typeof did !== 'string') return null;
  const primary = parsePushIdentity(did ?? caip);
  if (!primary) return null;
  if (did === undefined || caip === undefined) return primary;
  const secondary = parsePushIdentity(caip);
  if (primary === secondary) return primary;
  if (!secondary || !primary.startsWith('nft:') || !secondary.startsWith('nft:')) return null;
  // The CAIP form may omit the ownership epoch that the DID retains.
  if (primary.split(':').length === 6 && secondary === primary.split(':').slice(0, 5).join(':')) return primary;
  if (secondary.split(':').length === 6 && primary === secondary.split(':').slice(0, 5).join(':')) return secondary;
  return null;
}
