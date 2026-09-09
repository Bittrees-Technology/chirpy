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

const revisions = new Map<string, number>();

export async function pullRemoteBlob(address: string): Promise<EncryptedSyncBlobSnapshot | null> {
  const key = address.toLowerCase();
  const r = await fetch(`${URL_}?address=${encodeURIComponent(address)}`, { cache: "no-store" });
  if (!r.ok) throw new Error("Unable to read encrypted sync. Try again when storage is available.");
  const j = await r.json();
  // Parse before recording a revision, so corrupt data cannot be overwritten as an empty record.
  const blob = j?.blob ? JSON.parse(j.blob) as EncryptedSyncBlobSnapshot : null;
  const revision = Number(j?.revision) || 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid sync revision.");
  revisions.set(key, revision);
  return blob;
}

export async function pushBlob(address: string, authSig: string, enc: EncryptedSyncBlobSnapshot): Promise<PushBlobResult> {
  const key = address.toLowerCase();
  const expectedRevision = revisions.get(key);
  if (expectedRevision === undefined) return { ok: false, stale: true };
  try {
    const r = await fetch(URL_, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, signature: authSig, blob: JSON.stringify(enc), expectedRevision }),
    });
    if (r.ok) {
      const result = await r.json();
      if (!Number.isSafeInteger(result.revision) || result.revision <= expectedRevision) return { ok: false };
      // Never move a newer concurrently observed revision backwards.
      revisions.set(key, Math.max(revisions.get(key) ?? 0, result.revision));
      return { ok: true };
    }
    // A conflict never advances our revision: the remote data must be pulled and merged first.
    return { ok: false, stale: r.status === 409 };
  } catch { return { ok: false }; }
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
