import { validateWalletEmailArchive, type WalletEmailArchive } from './walletEmailArchive';
import { updateWalletEmailRecovery, WalletEmailReceiptError, type WalletEmailSnapshot } from './walletEmailReceipts';

export function mergeWalletEmailArchive(current: WalletEmailSnapshot, value: WalletEmailArchive, wallet: string, service: string) {
  const data = validateWalletEmailArchive(value, wallet, service);
  const ids = new Set(current.state.receipts.map(item => item.id));
  const added = data.ids.filter(id => !ids.has(id)).map(id => ({id, digest: null, createdAt: null}));
  if (current.state.receipts.length + added.length > 100) throw new WalletEmailReceiptError('limit');
  return {version: 1 as const, active: current.state.active ?? data.active, receipts: [...current.state.receipts, ...added]};
}

export async function restoreWalletEmailArchive(data: WalletEmailArchive, wallet: string, service: string,
  revision: string, assertCurrent: () => void, signal?: AbortSignal) {
  // Copy validated data before waiting for the lock so the caller cannot change the reviewed IDs.
  const copy = validateWalletEmailArchive(data, wallet, service);
  return updateWalletEmailRecovery(wallet, service, revision,
    current => mergeWalletEmailArchive(current, copy, wallet, service), assertCurrent, signal);
}

export function removableWalletEmailIds(snapshot: WalletEmailSnapshot) {
  // Preserve the old compatibility slot. Removing it requires a separate multi-key migration.
  return snapshot.state.receipts.filter(item => item.id !== snapshot.state.active && item.id !== snapshot.legacy).map(item => item.id);
}

/** UI must first verify encryption and obtain explicit acknowledgement that the backup was saved. */
export async function pruneBackedUpWalletEmailIds(wallet: string, service: string, revision: string,
  assertCurrent: () => void, signal?: AbortSignal) {
  return updateWalletEmailRecovery(wallet, service, revision, current => {
    const removable = new Set(removableWalletEmailIds(current));
    return {...current.state, receipts: current.state.receipts.filter(item => !removable.has(item.id))};
  }, assertCurrent, signal);
}
