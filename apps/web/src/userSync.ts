export const AUTH_MESSAGE =
  "Chirpy sync — authorize device writes (v1)\n\nSign to let this device save your encrypted sync blob. Gas-free; proves wallet ownership only.";

const URL_ = "/api/usersync";

export interface SettingsPrefsSnapshot {
  readReceiptsDefault: boolean;
  syncAcrossDevices: boolean;
  blocked: string[];
}

export interface SavedMessageSnapshot {
  id: string;
  [key: string]: unknown;
}

export interface SettingsSyncPayload {
  version: 1;
  settingsPrefs: SettingsPrefsSnapshot;
  savedMessages: SavedMessageSnapshot[];
  updatedAt: number;
}

export interface EncryptedSyncBlobSnapshot {
  version: 1;
  algorithm: "AES-GCM";
  kdf: "HKDF-SHA-256";
  address: string;
  iv: string;
  ciphertext: string;
  updatedAt: number;
}

export type PushBlobResult =
  | { ok: true }
  | { ok: false; stale?: boolean; updatedAt?: number };

export async function pullRemoteBlob(address: string): Promise<EncryptedSyncBlobSnapshot | null> {
  try {
    const r = await fetch(`${URL_}?address=${encodeURIComponent(address)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j?.blob ? JSON.parse(j.blob) as EncryptedSyncBlobSnapshot : null;
  } catch {
    return null;
  }
}

export async function pushBlob(
  address: string,
  authSig: string,
  enc: EncryptedSyncBlobSnapshot,
): Promise<PushBlobResult> {
  try {
    const r = await fetch(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address,
        signature: authSig,
        blob: JSON.stringify(enc),
        updatedAt: enc.updatedAt,
      }),
    });
    if (r.ok) return { ok: true };
    if (r.status !== 409) return { ok: false };
    const j = await r.json().catch(() => null);
    return { ok: false, stale: true, updatedAt: Number(j?.updatedAt) || undefined };
  } catch {
    return { ok: false };
  }
}

export function mergePayload(
  local: SettingsSyncPayload,
  remote: SettingsSyncPayload,
): SettingsSyncPayload {
  const savedMessages = new Map<string, SavedMessageSnapshot>();
  const isNewerMessage = (next: SavedMessageSnapshot, prev: SavedMessageSnapshot) => {
    const nextUpdated = typeof next.updatedAt === "number" ? next.updatedAt : remote.updatedAt;
    const prevUpdated = typeof prev.updatedAt === "number" ? prev.updatedAt : local.updatedAt;
    return nextUpdated >= prevUpdated;
  };
  for (const msg of local.savedMessages) {
    if (msg?.id) savedMessages.set(msg.id, msg);
  }
  for (const msg of remote.savedMessages) {
    const prev = msg?.id ? savedMessages.get(msg.id) : undefined;
    if (msg?.id && (!prev || isNewerMessage(msg, prev))) savedMessages.set(msg.id, msg);
  }

  const blocked = Array.from(new Set([
    ...local.settingsPrefs.blocked.map((address) => address.toLowerCase()),
    ...remote.settingsPrefs.blocked.map((address) => address.toLowerCase()),
  ].filter(Boolean)));
  const newer = remote.updatedAt > local.updatedAt ? remote : local;

  return {
    version: 1,
    settingsPrefs: {
      ...newer.settingsPrefs,
      blocked,
    },
    savedMessages: Array.from(savedMessages.values()),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}
