import { assertNoRecoveryPending, walletSettingsKey, withSettingsLock } from './settingsStorage';
// Device-local labels only. These values are neither identity proofs nor public profiles.
export const PROFILE_SAVE_ERROR = "Your display name could not be saved. Restore browser storage access and try again.";
export const PROFILE_LABEL_ERROR = "Use a display name of at most 80 characters without control characters.";
export const walletProfileKey = (address: string) => `chat:walletProfile:v1:${address.toLowerCase()}`;
export const validWalletLabel = (value: unknown): value is string => typeof value === "string" && value.length <= 80 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
export const WALLET_PROFILE_CHANGED = 'chat:wallet-profile-changed';
export function parseWalletLabelRaw(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  if (typeof raw !== 'string' || raw.length > 1024) throw new Error(PROFILE_SAVE_ERROR);
  const value: unknown = JSON.parse(raw);
  if (!validWalletLabel(value)) throw new Error(PROFILE_SAVE_ERROR);
  return value;
}
export function readWalletLabelRaw(address: string): string | null {
  walletSettingsKey(address);
  const raw = localStorage.getItem(walletProfileKey(address));
  parseWalletLabelRaw(raw);
  return raw;
}
export function notifyWalletLabel() { window.dispatchEvent(new Event(WALLET_PROFILE_CHANGED)); }

export function walletLabel(address: string): string | undefined {
  try {
    return parseWalletLabelRaw(localStorage.getItem(walletProfileKey(address)));
  } catch { return ""; }
}

export async function saveWalletLabel(address: string, value: string | undefined, ensureCurrent: () => void) {
  if (value !== undefined && !validWalletLabel(value)) throw new Error(PROFILE_LABEL_ERROR);
  try {
    const key = walletSettingsKey(address);
    await withSettingsLock(key, () => {
      ensureCurrent(); assertNoRecoveryPending(key);
      if (value === undefined) localStorage.removeItem(walletProfileKey(address));
      else localStorage.setItem(walletProfileKey(address), JSON.stringify(value));
      notifyWalletLabel();
    });
  } catch { throw new Error(PROFILE_SAVE_ERROR); }
}
