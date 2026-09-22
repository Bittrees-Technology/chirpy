import { recoveryCipher } from './recoveryCipher';
import { walletEmailReceiptKey } from './walletEmailReceipts';

/** Lookup IDs only: never message content, fingerprints, retry clocks or signing authority. */
export type WalletEmailArchive = {
  version: 1; wallet: string; service: string; createdAt: number; active: string | null; ids: string[];
};
export const MAX_EMAIL_ARCHIVE_FILE_BYTES = 16 * 1024;
const cipher = recoveryCipher('chat-email-requests', 'Chat email requests v1;AES-256-GCM;PBKDF2-SHA-256;600000',
  {bytes: 8 * 1024, fileBytes: MAX_EMAIL_ARCHIVE_FILE_BYTES});
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

export function validateWalletEmailArchive(value: unknown, wallet: string, service: string): WalletEmailArchive {
  walletEmailReceiptKey(wallet, service);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid email recovery file');
  const data = value as WalletEmailArchive;
  if (Object.keys(data).sort().join(',') !== 'active,createdAt,ids,service,version,wallet'
    || data.version !== 1 || data.wallet !== wallet || data.service !== service
    || !Number.isSafeInteger(data.createdAt) || data.createdAt < 0 || data.createdAt > 8_640_000_000_000_000
    || !Array.isArray(data.ids) || data.ids.length > 100 || !data.ids.every(validId)
    || new Set(data.ids).size !== data.ids.length || !(data.active === null || validId(data.active) && data.ids.includes(data.active))) {
    throw new Error('Invalid email recovery file or different wallet/service');
  }
  return {version: 1, wallet, service, createdAt: data.createdAt, active: data.active, ids: [...data.ids]};
}

export async function encryptWalletEmailArchive(value: WalletEmailArchive, password: string): Promise<string> {
  return cipher.encrypt(validateWalletEmailArchive(value, value.wallet, value.service), password);
}
/** Authority and service come from the verified current session, never from the archive. */
export async function decryptWalletEmailArchive(raw: string, password: string, wallet: string, service: string): Promise<WalletEmailArchive> {
  walletEmailReceiptKey(wallet, service);
  return validateWalletEmailArchive(await cipher.decrypt(raw, password), wallet, service);
}
