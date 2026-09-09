// Translate known application messages; preserve unknown provider diagnostics verbatim.
const keys: Record<string, string> = {
  "Encrypted sync is enabled for this browser session, for up to 24 hours.": "status.syncEnabled",
  "Sync is off and this device authorization was revoked.": "status.syncRevoked",
  "Sync is off locally. Use Revoke all sync devices to revoke earlier sessions.": "status.syncLocalOff",
  "All existing sync device authorizations were revoked. Your encrypted saved data is retained.": "status.syncAllRevoked",
  "Settings changed while syncing. Your local choices are saved; enable sync again to retry.": "status.syncChanged",
  "Sync failed. Local changes are saved on this device; retry sync when available.": "status.syncFailed",
  "Remote sync could not be read. Local data is unchanged.": "status.syncUnreadable",
  "Sync authorization expired. Re-enable sync with your wallet.": "status.syncExpired",
  "Connect a wallet before enabling encrypted sync.": "status.syncConnect",
  "Another device changed sync again. Try enabling sync again.": "status.syncConflict",
  "Encrypted sync was not saved. Try again; local data has been kept.": "status.syncUnsaved",
  "Encrypted sync could not be decrypted. Remote data has been preserved.": "status.syncUndecryptable",
  "Sync stopped locally; revocation was not confirmed.": "status.revokeUnconfirmed",
  "Connect a wallet to revoke sync devices.": "status.revokeConnect",
  "Revocation was not confirmed. Retry when connected.": "status.revokeRetry",
  "Wallet signature was rejected or unavailable. Sync stayed off.": "status.keyRejected",
  "Wallet changed. Re-enable sync for the current wallet.": "status.walletChanged",
  "Wallet account changed. Reconnect before enabling sync.": "status.accountChanged",
  "Wallet account changed. Reconnect before authorizing sync.": "status.authChanged",
  "No wallet provider is connected. Connect a wallet, then try again.": "status.walletMissing",
  "Connect a wallet before authorizing sync.": "status.authConnect",
  "Wallet did not return an account.": "status.accountMissing",
  "Wallet did not return a signature.": "status.signatureMissing",
  "Wallet returned an invalid signature.": "status.signatureInvalid",
  "Secure browser crypto is unavailable.": "status.cryptoMissing",
  "No injected wallet was found. Local identity mode is still available.": "status.walletInjectedMissing",
  "Unable to read encrypted sync. Try again when storage is available.": "status.syncReadFailed",
  "Invalid sync revision.": "status.syncRevisionInvalid",
  "Sync service authorization is unavailable or has the wrong origin.": "status.syncWrongService",
  "Sync stopped locally, but server revocation was not confirmed. Revoke all sync devices when connected.": "status.revokeServerUnconfirmed"
};
export function translateStatus(t: (key: string, fallback?: string) => string, message: string): string {
  return Object.hasOwn(keys, message) ? t(keys[message], message) : message;
}
