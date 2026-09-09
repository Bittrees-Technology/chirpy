export declare const SYNC_AUTH_MAX_AGE: number;
export interface SyncDeviceGrant {
  version: 2;
  service: string;
  address: string;
  device: string;
  issuedAt: number;
  expiresAt: number;
  epoch: number;
}
export declare function syncGrantMessage(grant: SyncDeviceGrant): string;
export declare function syncWriteMessage(grant: SyncDeviceGrant, revision: number, blobHash: string): string;
export declare function syncRevokeDeviceMessage(grant: SyncDeviceGrant): string;
export declare function syncRevokeAllMessage(service: string, address: string, epoch: number, expiresAt: number): string;
