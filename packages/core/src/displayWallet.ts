import { profileAddress } from './publicProfile.js';
export type DisplayNetwork = 'production' | 'dev';
export type DisplayWalletRecord = { version: 1; wallet: string; network: DisplayNetwork; inboxId: string | null; displayWallet: string | null; revision: number; updatedAt: number };
export type DisplayWalletCommand = Omit<DisplayWalletRecord, 'updatedAt'> & { service: string; expiresAt: number };
export const displayNetwork = (value: unknown): value is DisplayNetwork => value === 'production' || value === 'dev';
export const displayInbox = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, keys: string): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
export function validDisplayWalletRecord(value: unknown, wallet: string, network: DisplayNetwork): value is DisplayWalletRecord {
  return exact(value, 'displayWallet,inboxId,network,revision,updatedAt,version,wallet') && value.version === 1 && value.wallet === wallet && profileAddress(wallet) && value.network === network && displayNetwork(network)
    && revision(value.revision) && Number.isSafeInteger(value.updatedAt) && Number(value.updatedAt) >= 0
    && (value.displayWallet === null || profileAddress(value.displayWallet))
    && (value.revision === 0 ? value.inboxId === null && value.displayWallet === null && value.updatedAt === 0 : displayInbox(value.inboxId) && Number(value.updatedAt) > 0);
}
export function validDisplayWalletCommand(value: unknown, service: string, now = Date.now()): value is DisplayWalletCommand {
  return exact(value, 'displayWallet,expiresAt,inboxId,network,revision,service,version,wallet') && value.version === 1 && value.service === service && profileAddress(value.wallet) && displayNetwork(value.network)
    && displayInbox(value.inboxId) && (value.displayWallet === null || profileAddress(value.displayWallet)) && revision(value.revision) && value.revision < Number.MAX_SAFE_INTEGER - 1
    && Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > now && Number(value.expiresAt) <= now + 300000;
}
export function displayWalletSignMessage(command: DisplayWalletCommand): string {
  return `Chat display wallet v1\nService: ${command.service}\nSigning wallet: ${command.wallet}\nXMTP network: ${command.network}\nInbox: ${command.inboxId}\nCurrent revision: ${command.revision}\nDisplay wallet: ${command.displayWallet ?? 'automatic'}\nExpires: ${command.expiresAt}\nPublish this display choice for wallets currently linked to this inbox. The choice and inbox association are public.\nThis does not link wallets, verify identity or authorize messages, room access, mailbox access or transactions.`;
}
/** The caller supplies current SDK-verified links, never a list from profile storage.
 * Newest current-author intent wins (wallet breaks same-millisecond ties). A reset
 * or now-invalid target falls back to automatic, never resurrecting an older choice.
 */
export function selectDisplayWallet(records: unknown, inboxId: string, network: DisplayNetwork, linkedWallets: readonly string[]): string | undefined {
  if (!displayInbox(inboxId) || !displayNetwork(network) || !Array.isArray(records) || linkedWallets.length > 100 || records.length > 100 || !linkedWallets.every(profileAddress)) return;
  const linked = new Set(linkedWallets);
  if (linked.size !== linkedWallets.length || records.length !== linked.size) return;
  const byWallet = new Map<string, DisplayWalletRecord>();
  const seen = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== 'object' || !profileAddress(record.wallet) || !linked.has(record.wallet)) return;
    // An ambiguous response must not choose an arbitrary duplicate's intent.
    if (seen.has(record.wallet)) return;
    seen.add(record.wallet);
    if (!validDisplayWalletRecord(record, record.wallet, network)) return;
    if (record.inboxId === inboxId && record.revision > 0) byWallet.set(record.wallet, record);
  }
  const latest = [...byWallet.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.wallet === b.wallet ? 0 : a.wallet < b.wallet ? 1 : -1))[0];
  return latest?.displayWallet && linked.has(latest.displayWallet) ? latest.displayWallet : undefined;
}
