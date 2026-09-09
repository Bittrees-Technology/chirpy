/** Canonical messages shared by browser and server. Never sign server-supplied free text. */
export const SYNC_AUTH_MAX_AGE = 24 * 60 * 60_000;
export interface SyncDeviceGrant {
  version: 2;
  service: string;
  address: string;
  device: string;
  issuedAt: number;
  expiresAt: number;
  epoch: number;
}
export function syncGrantMessage(grant: SyncDeviceGrant): string {
  return `Chirpy sync device authorization (v2)\nService: ${grant.service}\nWallet: ${grant.address.toLowerCase()}\nDevice: ${grant.device.toLowerCase()}\nIssued: ${grant.issuedAt}\nExpires: ${grant.expiresAt}\nEpoch: ${grant.epoch}\nAllow this device to write encrypted settings until expiry or revocation. Gas-free; does not authorize transactions.`;
}
export function syncWriteMessage(grant: SyncDeviceGrant, revision: number, blobHash: string): string {
  return `${syncGrantMessage(grant)}\nOperation: write\nExpected revision: ${revision}\nBlob hash: ${blobHash}`;
}
export function syncRevokeDeviceMessage(grant: SyncDeviceGrant): string {
  return `${syncGrantMessage(grant)}\nOperation: revoke this device authorization`;
}
export function syncRevokeAllMessage(service: string, address: string, epoch: number, expiresAt: number): string {
  return `Chirpy sync revocation (v2)\nService: ${service}\nWallet: ${address.toLowerCase()}\nEpoch: ${epoch}\nExpires: ${expiresAt}\nRevoke all existing sync device authorizations. Encrypted saved data is retained. Gas-free; does not authorize transactions.`;
}
