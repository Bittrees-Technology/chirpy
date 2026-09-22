// Device-local labels only. These values are neither identity proofs nor public profiles.
export const PROFILE_SAVE_ERROR = "Your display name could not be saved. Restore browser storage access and try again.";
export const PROFILE_LABEL_ERROR = "Use a display name of at most 80 characters without control characters.";
export const walletProfileKey = (address: string) => `chat:walletProfile:v1:${address.toLowerCase()}`;
const valid = (value: unknown): value is string => typeof value === "string" && value.length <= 80 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);

export function walletLabel(address: string): string | undefined {
  try {
    const raw = localStorage.getItem(walletProfileKey(address));
    if (raw === null) return undefined; // No choice: retain the existing ENS fallback.
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : ""; // An invalid choice must not become an ENS opt-in.
  } catch { return ""; }
}

export function saveWalletLabel(address: string, value: string | undefined) {
  if (value !== undefined && !valid(value)) throw new Error(PROFILE_LABEL_ERROR);
  try {
    if (value === undefined) localStorage.removeItem(walletProfileKey(address));
    else localStorage.setItem(walletProfileKey(address), JSON.stringify(value));
  } catch { throw new Error(PROFILE_SAVE_ERROR); }
}
