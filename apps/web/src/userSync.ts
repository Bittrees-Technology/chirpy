import { keccak256, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SYNC_AUTH_MAX_AGE, syncGrantMessage, syncWriteMessage, syncRevokeDeviceMessage, syncRevokeAllMessage, type SyncDeviceGrant } from "@app/core";

import { syncEndpoint } from "./apiEndpoint";
export interface SettingsPrefsSnapshot { readReceiptOverrides?: Record<string, boolean>; readReceiptsDefault: boolean; syncAcrossDevices: boolean; blocked: string[]; }
export interface SavedMessageSnapshot { id: string; [key: string]: unknown; }
export interface SettingsSyncPayload { version: 1; settingsPrefs: SettingsPrefsSnapshot; savedMessages: SavedMessageSnapshot[]; updatedAt: number; }
export interface EncryptedSyncBlobSnapshot { version: 1; algorithm: "AES-GCM"; kdf: "HKDF-SHA-256"; address: string; iv: string; ciphertext: string; updatedAt: number; }
export type PushBlobResult = { ok: true } | { ok: false; stale?: boolean; updatedAt?: number };
export interface SyncAuthorization {
  grant: SyncDeviceGrant & { signature: string };
  sign: (message: string) => Promise<`0x${string}`>;
}
const revisions = new Map<string, number>();
const contexts = new Map<string, { service: string; epoch: number }>();
type WalletSign = (message: string) => Promise<string>;
function serviceUrl() { return syncEndpoint().service; }

export async function pullRemoteBlob(address: string): Promise<EncryptedSyncBlobSnapshot | null> {
  const key = address.toLowerCase();
  const response = await fetch(`${syncEndpoint().requestUrl}?address=${encodeURIComponent(address)}`, { credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Unable to read encrypted sync. Try again when storage is available.");
  const result = await response.json();
  const blob = result?.blob ? JSON.parse(result.blob) as EncryptedSyncBlobSnapshot : null;
  const revision = result?.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid sync revision.");
  if (result.authVersion !== 2 || result.service !== serviceUrl() || !Number.isSafeInteger(result.epoch) || result.epoch < 0) throw new Error("Sync service authorization is unavailable or has the wrong origin.");
  revisions.set(key, revision);
  contexts.set(key, { service: result.service, epoch: result.epoch });
  return blob;
}
export async function createSyncAuthorization(address: string, walletSign: WalletSign): Promise<SyncAuthorization> {
  await pullRemoteBlob(address);
  const context = contexts.get(address.toLowerCase())!;
  const device = privateKeyToAccount(generatePrivateKey());
  const issuedAt = Date.now();
  const grant: SyncDeviceGrant = { version: 2, ...context, address: address.toLowerCase(), device: device.address.toLowerCase(), issuedAt, expiresAt: issuedAt + SYNC_AUTH_MAX_AGE };
  const signature = await walletSign(syncGrantMessage(grant));
  // The generated key is retained only in this closure, never written to browser storage.
  return { grant: { ...grant, signature }, sign: (message) => device.signMessage({ message }) };
}
export async function pushBlob(address: string, authorization: SyncAuthorization, enc: EncryptedSyncBlobSnapshot): Promise<PushBlobResult> {
  const key = address.toLowerCase();
  const expectedRevision = revisions.get(key);
  if (expectedRevision === undefined) return { ok: false, stale: true };
  if (authorization.grant.address !== key || authorization.grant.service !== serviceUrl() || authorization.grant.expiresAt <= Date.now()) return { ok: false };
  try {
    const blob = JSON.stringify(enc);
    const signature = await authorization.sign(syncWriteMessage(authorization.grant, expectedRevision, keccak256(stringToHex(blob))));
    const response = await fetch(syncEndpoint().requestUrl, { credentials: "omit", redirect: "error", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "write", address, authorization: authorization.grant, signature, blob, expectedRevision }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { ok: false, stale: response.status === 409 };
    const result = await response.json();
    if (!Number.isSafeInteger(result.revision) || result.revision <= expectedRevision) return { ok: false };
    revisions.set(key, Math.max(revisions.get(key) ?? 0, result.revision));
    return { ok: true };
  } catch { return { ok: false }; }
}
export async function revokeSyncAuthorization(authorization: SyncAuthorization): Promise<void> {
  if (authorization.grant.expiresAt <= Date.now()) return; // Expired grants cannot write.
  const signature = await authorization.sign(syncRevokeDeviceMessage(authorization.grant));
  const response = await fetch(syncEndpoint().requestUrl, { credentials: "omit", redirect: "error", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "revoke-device", address: authorization.grant.address, authorization: authorization.grant, signature }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Sync stopped locally, but server revocation was not confirmed. Revoke all sync devices when connected.");
}
export async function revokeAllSyncAuthorizations(address: string, walletSign: WalletSign): Promise<void> {
  await pullRemoteBlob(address);
  const { service, epoch } = contexts.get(address.toLowerCase())!;
  const expiresAt = Date.now() + 300_000;
  const signature = await walletSign(syncRevokeAllMessage(service, address, epoch, expiresAt));
  const response = await fetch(syncEndpoint().requestUrl, { credentials: "omit", redirect: "error", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "revoke-all", address, epoch, expiresAt, signature }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Revocation was not confirmed. Refresh and retry.");
  contexts.delete(address.toLowerCase());
}

// JSON objects can arrive with different key insertion orders on each device.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function mergePayload(
  local: SettingsSyncPayload,
  remote: SettingsSyncPayload,
): SettingsSyncPayload {
  const savedMessages = new Map<string, SavedMessageSnapshot>();
  for (const source of [local, remote]) {
    for (const message of source.savedMessages) {
      if (!message?.id) continue;
      // Persist legacy fallback times so an unrelated later preference update
      // cannot make an old message appear newer during the next exchange.
      const updatedAt = typeof message.updatedAt === "number" && Number.isFinite(message.updatedAt) && message.updatedAt >= 0
        ? message.updatedAt : source.updatedAt;
      const next = { ...message, updatedAt };
      const prev = savedMessages.get(message.id);
      if (!prev || updatedAt > (prev.updatedAt as number) ||
          (updatedAt === prev.updatedAt && canonicalJson(next) > canonicalJson(prev))) {
        savedMessages.set(message.id, next);
      }
    }
  }

  const blocked = Array.from(new Set([
    ...local.settingsPrefs.blocked.map((address) => address.toLowerCase()),
    ...remote.settingsPrefs.blocked.map((address) => address.toLowerCase()),
  ].filter(Boolean))).sort();
  let settingsPrefs = (remote.updatedAt > local.updatedAt ? remote : local).settingsPrefs;
  if (local.updatedAt === remote.updatedAt) {
    const a = local.settingsPrefs;
    const b = remote.settingsPrefs;
    const keys = Array.from(new Set([...Object.keys(a.readReceiptOverrides ?? {}), ...Object.keys(b.readReceiptOverrides ?? {})])).sort();
    // An equal-time conflict must not enable receipts or sync on either device.
    // Missing versus explicit overrides also resolve to an explicit off choice.
    settingsPrefs = {
      readReceiptsDefault: a.readReceiptsDefault && b.readReceiptsDefault,
      syncAcrossDevices: a.syncAcrossDevices && b.syncAcrossDevices,
      blocked,
      ...(keys.length ? { readReceiptOverrides: Object.fromEntries(keys.map(key => [key, a.readReceiptOverrides?.[key] === true && b.readReceiptOverrides?.[key] === true])) } : {}),
    };
  }

  return {
    version: 1,
    settingsPrefs: { ...settingsPrefs, blocked, readReceiptOverrides: Object.fromEntries(Object.entries(settingsPrefs.readReceiptOverrides ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) },
    savedMessages: Array.from(savedMessages.values()).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}
