import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  PERSONAL_ORG, type Identity, type OrgConfig, type Policy,
} from "@app/core";
import {
  createTransport, type ChatMessage, type Conversation, type StartRoomInput, type Transport,
} from "@app/transport";
import { DEFAULT_TRANSPORT } from "./app.config";
import { resolveEns, type EnsRecord } from "./ens";
import {
  clearActiveProvider,
  connectWalletConnect as connectWalletConnectProvider,
  getActiveKind,
  getActiveProvider,
  getInjectedEthereum,
  restoreWalletConnect,
  setActiveProvider,
  walletConnectAvailable,
  type WalletEventProvider,
} from "./walletProviders";
import {
  AUTH_MESSAGE,
  mergePayload,
  pullRemoteBlob,
  pushBlob,
  type EncryptedSyncBlobSnapshot,
  type SettingsSyncPayload,
} from "./userSync";

// ---------- storage helpers ----------
const LS = {
  get<T>(k: string, fallback: T): T {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
  },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } },
  remove(k: string) { try { localStorage.removeItem(k); } catch { /* */ } },
};
const randAddr = () => {
  const hex = "0123456789abcdef"; let s = "0x";
  for (let i = 0; i < 40; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
};

const accountFromResponse = (accounts: unknown): string | null =>
  Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;

// ====================================================================
// Identity
// ====================================================================
type IdentityMode = "stub" | "wallet";
interface IdentityCtx {
  identity: Identity;
  mode: IdentityMode;
  hasInjectedWallet: boolean;
  walletConnectAvailable: boolean;
  isConnecting: boolean;
  ensProfile: EnsRecord | null;
  walletError: string | null;
  setHandle: (h: string) => void;
  reset: () => void;
  connectWallet: () => Promise<void>;
  connectWalletConnect: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
}
const IdentityContext = createContext<IdentityCtx | null>(null);
const IDENTITY_KEY = "chat:identity:v1";
const WALLET_CONNECTED_KEY = "chat:walletConnected:v1";
const WALLET_PROVIDER_KIND_KEY = "chat:walletProviderKind:v1";

const normalizeAddress = (address: string) => address.trim();
const identityFromWallet = (address: string, profile?: EnsRecord | null): Identity => ({
  address: normalizeAddress(address),
  handle: profile?.displayName ?? profile?.name ?? undefined,
});

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [stubIdentity, setStubIdentity] = useState<Identity>(() =>
    LS.get<Identity>(IDENTITY_KEY, { address: randAddr(), handle: "you" }));
  const [walletIdentity, setWalletIdentity] = useState<Identity | null>(null);
  const [mode, setMode] = useState<IdentityMode>("stub");
  const [hasInjectedWallet, setHasInjectedWallet] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [ensProfile, setEnsProfile] = useState<EnsRecord | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const walletProviderCleanupRef = useRef<(() => void) | null>(null);

  const applyWalletAccount = useCallback(async (address: string) => {
    const normalized = normalizeAddress(address);
    let profile: EnsRecord | null = null;
    try {
      profile = await resolveEns(normalized);
    } catch {
      profile = null;
    }
    setEnsProfile(profile);
    setWalletIdentity(identityFromWallet(normalized, profile));
    setMode("wallet");
    LS.set(WALLET_CONNECTED_KEY, true);
  }, []);

  const resetWalletState = useCallback(() => {
    LS.remove(WALLET_CONNECTED_KEY);
    LS.remove(WALLET_PROVIDER_KIND_KEY);
    walletProviderCleanupRef.current?.();
    walletProviderCleanupRef.current = null;
    clearActiveProvider();
    setWalletIdentity(null);
    setEnsProfile(null);
    setMode("stub");
    setWalletError(null);
  }, []);

  const attachProviderEvents = useCallback((provider: WalletEventProvider) => {
    walletProviderCleanupRef.current?.();
    const onAccountsChanged = (accounts: string[]) => {
      const address = accountFromResponse(accounts);
      if (address) {
        setWalletError(null);
        void applyWalletAccount(address);
        return;
      }
      resetWalletState();
    };
    const onDisconnect = () => resetWalletState();
    provider.on?.("accountsChanged", onAccountsChanged);
    provider.on?.("disconnect", onDisconnect);
    provider.on?.("session_delete", onDisconnect);
    walletProviderCleanupRef.current = () => {
      provider.removeListener?.("accountsChanged", onAccountsChanged);
      provider.removeListener?.("disconnect", onDisconnect);
      provider.removeListener?.("session_delete", onDisconnect);
    };
  }, [applyWalletAccount, resetWalletState]);

  useEffect(() => { LS.set(IDENTITY_KEY, stubIdentity); }, [stubIdentity]);
  useEffect(() => {
    const ethereum = getInjectedEthereum();
    setHasInjectedWallet(Boolean(ethereum));
    if (!ethereum) return undefined;

    let cancelled = false;
    if (
      LS.get<boolean>(WALLET_CONNECTED_KEY, false) &&
      LS.get<string | null>(WALLET_PROVIDER_KIND_KEY, null) !== "walletconnect"
    ) {
      ethereum.request({ method: "eth_accounts" })
        .then((accounts) => {
          if (cancelled) return;
          const address = accountFromResponse(accounts);
          if (address) {
            setActiveProvider(ethereum, "injected");
            LS.set(WALLET_PROVIDER_KIND_KEY, "injected");
            void applyWalletAccount(address);
          }
          else LS.remove(WALLET_CONNECTED_KEY);
        })
        .catch(() => {
          if (!cancelled) LS.remove(WALLET_CONNECTED_KEY);
        });
    }

    const onAccountsChanged = (accounts: string[]) => {
      if (getActiveKind() && getActiveKind() !== "injected") return;
      const address = accountFromResponse(accounts);
      if (address) {
        setWalletError(null);
        void applyWalletAccount(address);
        return;
      }
      LS.remove(WALLET_CONNECTED_KEY);
      LS.remove(WALLET_PROVIDER_KIND_KEY);
      clearActiveProvider();
      setWalletIdentity(null);
      setEnsProfile(null);
      setMode("stub");
    };
    ethereum.on?.("accountsChanged", onAccountsChanged);
    return () => {
      cancelled = true;
      ethereum.removeListener?.("accountsChanged", onAccountsChanged);
    };
  }, [applyWalletAccount]);

  useEffect(() => {
    if (LS.get<string | null>(WALLET_PROVIDER_KIND_KEY, null) !== "walletconnect") return undefined;
    if (!walletConnectAvailable()) {
      LS.remove(WALLET_CONNECTED_KEY);
      LS.remove(WALLET_PROVIDER_KIND_KEY);
      return undefined;
    }
    let cancelled = false;
    restoreWalletConnect()
      .then((restored) => {
        if (cancelled || !restored) {
          if (!cancelled) {
            LS.remove(WALLET_CONNECTED_KEY);
            LS.remove(WALLET_PROVIDER_KIND_KEY);
          }
          return;
        }
        attachProviderEvents(restored.provider);
        void applyWalletAccount(restored.address);
      })
      .catch(() => {
        if (!cancelled) {
          LS.remove(WALLET_CONNECTED_KEY);
          LS.remove(WALLET_PROVIDER_KIND_KEY);
        }
      });
    return () => { cancelled = true; };
  }, [applyWalletAccount, attachProviderEvents]);

  const identity = walletIdentity ?? stubIdentity;
  const value = useMemo<IdentityCtx>(() => ({
    identity,
    mode,
    hasInjectedWallet,
    walletConnectAvailable: walletConnectAvailable(),
    isConnecting,
    ensProfile,
    walletError,
    setHandle: (h) => {
      const handle = h.trim() || "you";
      if (mode === "wallet") setWalletIdentity((p) => (p ? { ...p, handle } : p));
      else setStubIdentity((p) => ({ ...p, handle }));
    },
    reset: () => setStubIdentity({ address: randAddr(), handle: "you" }),
    connectWallet: async () => {
      const ethereum = getInjectedEthereum();
      if (!ethereum) {
        setHasInjectedWallet(false);
        setWalletError("No injected wallet was found. Local identity mode is still available.");
        return;
      }
      setIsConnecting(true);
      setWalletError(null);
      try {
        const accounts = await ethereum.request({ method: "eth_requestAccounts" });
        const address = accountFromResponse(accounts);
        if (!address) throw new Error("Wallet did not return an account.");
        setActiveProvider(ethereum, "injected");
        LS.set(WALLET_PROVIDER_KIND_KEY, "injected");
        await applyWalletAccount(address);
      } catch (err) {
        const message = err instanceof Error && err.message ? err.message : "Wallet connection was rejected or unavailable.";
        setWalletError(message);
      } finally {
        setIsConnecting(false);
      }
    },
    connectWalletConnect: async () => {
      if (!walletConnectAvailable()) return;
      setIsConnecting(true);
      setWalletError(null);
      try {
        const { provider, address } = await connectWalletConnectProvider();
        LS.set(WALLET_PROVIDER_KIND_KEY, "walletconnect");
        attachProviderEvents(provider);
        await applyWalletAccount(address);
      } catch (err) {
        const message = err instanceof Error && err.message ? err.message : "WalletConnect connection was rejected or unavailable.";
        setWalletError(message);
      } finally {
        setIsConnecting(false);
      }
    },
    disconnectWallet: async () => {
      const provider = getActiveProvider();
      const kind = getActiveKind();
      resetWalletState();
      if (kind === "walletconnect") {
        await provider?.disconnect?.().catch(() => undefined);
      }
    },
  }), [applyWalletAccount, attachProviderEvents, ensProfile, hasInjectedWallet, identity, isConnecting, mode, resetWalletState, walletError]);
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}
export const useIdentity = () => {
  const c = useContext(IdentityContext);
  if (!c) throw new Error("useIdentity outside provider");
  return c;
};

// ====================================================================
// Orgs  (org-agnostic: Personal is always present; everything else imported/created)
// ====================================================================
interface OrgCtx {
  orgs: OrgConfig[];
  activeOrg: OrgConfig;
  activeOrgId: string;
  setActiveOrg: (id: string) => void;
  addOrg: (org: OrgConfig) => void;
  removeOrg: (id: string) => void;
}
const OrgContext = createContext<OrgCtx | null>(null);
const ORGS_KEY = "chat:orgs:v1";
const ACTIVE_KEY = "chat:activeOrg:v1";

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const [userOrgs, setUserOrgs] = useState<OrgConfig[]>(() => LS.get<OrgConfig[]>(ORGS_KEY, []));
  const [activeOrgId, setActiveOrgId] = useState<string>(() => LS.get<string>(ACTIVE_KEY, PERSONAL_ORG.id));

  useEffect(() => { LS.set(ORGS_KEY, userOrgs); }, [userOrgs]);
  useEffect(() => { LS.set(ACTIVE_KEY, activeOrgId); }, [activeOrgId]);

  const orgs = useMemo(() => [PERSONAL_ORG, ...userOrgs], [userOrgs]);
  const activeOrg = useMemo(
    () => orgs.find((o) => o.id === activeOrgId) ?? PERSONAL_ORG,
    [orgs, activeOrgId],
  );

  // Apply org branding to the document theme, including optional drop-in CSS.
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", activeOrg.branding.accent || "#F7931A");
    document.title = `${activeOrg.branding.name} · Chirpy`;
    const ID = "org-theme-css";
    let el = document.getElementById(ID) as HTMLStyleElement | null;
    const css = activeOrg.branding.themeCss?.trim();
    if (css) {
      if (!el) { el = document.createElement("style"); el.id = ID; document.head.appendChild(el); }
      el.textContent = css;
    } else if (el) {
      el.remove();
    }
  }, [activeOrg]);

  const addOrg = useCallback((org: OrgConfig) => {
    setUserOrgs((p) => {
      const without = p.filter((o) => o.id !== org.id);
      return [...without, org];
    });
    setActiveOrgId(org.id);
  }, []);

  const removeOrg = useCallback((id: string) => {
    if (id === PERSONAL_ORG.id) return;
    setUserOrgs((p) => p.filter((o) => o.id !== id));
    setActiveOrgId((cur) => (cur === id ? PERSONAL_ORG.id : cur));
  }, []);

  const value = useMemo<OrgCtx>(() => ({
    orgs, activeOrg, activeOrgId, setActiveOrg: setActiveOrgId, addOrg, removeOrg,
  }), [orgs, activeOrg, activeOrgId, addOrg, removeOrg]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}
export const useOrgs = () => {
  const c = useContext(OrgContext);
  if (!c) throw new Error("useOrgs outside provider");
  return c;
};

// ====================================================================
// Settings preferences
// ====================================================================
interface SettingsPrefs {
  readReceiptsDefault: boolean;
  syncAcrossDevices: boolean;
  blocked: string[];
}
interface EncryptedSyncBlob extends EncryptedSyncBlobSnapshot {
  version: 1;
  algorithm: "AES-GCM";
  kdf: "HKDF-SHA-256";
  address: string;
  iv: string;
  ciphertext: string;
  updatedAt: number;
}
interface SettingsSyncState {
  walletAddress: string | null;
  encryptedAt: number | null;
  hasSessionKey: boolean;
  isEncrypting: boolean;
}
interface SettingsSyncResult {
  ok: boolean;
  message: string;
}
interface SettingsPrefsCtx {
  prefs: SettingsPrefs;
  syncState: SettingsSyncState;
  setReadReceiptsDefault: (on: boolean) => void;
  enableSyncAcrossDevices: () => Promise<SettingsSyncResult>;
  disableSyncAcrossDevices: () => void;
}
const SettingsPrefsContext = createContext<SettingsPrefsCtx | null>(null);
const SETTINGS_PREFS_KEY = "chat:settingsPrefs:v1";
const SETTINGS_SYNC_BLOB_KEY = "chat:settingsSyncBlob:v1";
const SETTINGS_SYNC_AUTH_SIG_PREFIX = "chirpy.sync.authSig.";
const DEFAULT_SETTINGS_PREFS: SettingsPrefs = {
  readReceiptsDefault: true,
  syncAcrossDevices: false,
  blocked: [],
};

const textEncoder = new TextEncoder();
const bytesToHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const hexToBytes = (hex: string) => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!clean || clean.length % 2 !== 0 || /[^a-fA-F0-9]/.test(clean)) throw new Error("Wallet returned an invalid signature.");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
};
const base64ToBytes = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

async function deriveSyncKey(signature: string, address: string): Promise<CryptoKey> {
  if (!crypto.subtle) throw new Error("Secure browser crypto is unavailable.");
  const signatureKey = await crypto.subtle.importKey("raw", hexToBytes(signature), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(`Chirpy encrypted sync v1:${address.toLowerCase()}`),
      info: textEncoder.encode("settings-prefs-and-saved-messages"),
    },
    signatureKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function requestWalletSyncKey(preferredAddress?: string): Promise<{ address: string; key: CryptoKey }> {
  const ethereum = getActiveProvider();
  if (!ethereum) throw new Error("No wallet provider is connected. Connect a wallet, then try again.");
  const accounts = preferredAddress
    ? await ethereum.request({ method: "eth_accounts" })
    : await ethereum.request({ method: "eth_requestAccounts" });
  const account = accountFromResponse(accounts);
  const address = preferredAddress && account?.toLowerCase() === preferredAddress.toLowerCase()
    ? preferredAddress
    : account;
  if (!address) throw new Error("Wallet did not return an account.");
  const message = `Chirpy: enable encrypted sync\nAddress: ${address}\nThis is a gas-free signature used only to derive your sync key.`;
  const signature = await ethereum.request({
    method: "personal_sign",
    params: [bytesToHex(textEncoder.encode(message)), address],
  });
  if (typeof signature !== "string") throw new Error("Wallet did not return a signature.");
  return { address, key: await deriveSyncKey(signature, address) };
}

async function requestWalletSyncAuthSignature(address: string): Promise<string> {
  const ethereum = getActiveProvider();
  if (!ethereum) throw new Error("No wallet provider is connected. Connect a wallet, then try again.");
  const signature = await ethereum.request({
    method: "personal_sign",
    params: [bytesToHex(textEncoder.encode(AUTH_MESSAGE)), address],
  });
  if (typeof signature !== "string") throw new Error("Wallet did not return a sync authorization signature.");
  return signature;
}

async function encryptSyncPayload(payload: SettingsSyncPayload, key: CryptoKey, address: string): Promise<EncryptedSyncBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(JSON.stringify(payload)),
  );
  return {
    version: 1,
    algorithm: "AES-GCM",
    kdf: "HKDF-SHA-256",
    address,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    updatedAt: payload.updatedAt,
  };
}

const payloadFromPrefs = (prefs: SettingsPrefs, savedMessages: SettingsSyncPayload["savedMessages"] = []): SettingsSyncPayload => ({
  version: 1,
  settingsPrefs: prefs,
  savedMessages,
  updatedAt: Date.now(),
});

async function encryptSettingsPayload(
  prefs: SettingsPrefs,
  key: CryptoKey,
  address: string,
  savedMessages: SettingsSyncPayload["savedMessages"] = [],
): Promise<EncryptedSyncBlob> {
  return encryptSyncPayload(payloadFromPrefs(prefs, savedMessages), key, address);
}

async function decryptSettingsPayload(blob: EncryptedSyncBlob, key: CryptoKey): Promise<SettingsSyncPayload> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(blob.iv) },
    key,
    base64ToBytes(blob.ciphertext),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as SettingsSyncPayload;
  return {
    version: 1,
    settingsPrefs: {
      ...DEFAULT_SETTINGS_PREFS,
      ...parsed.settingsPrefs,
      blocked: Array.isArray(parsed.settingsPrefs?.blocked) ? parsed.settingsPrefs.blocked : [],
    },
    savedMessages: Array.isArray(parsed.savedMessages) ? parsed.savedMessages.filter((m) => typeof m?.id === "string") : [],
    updatedAt: Number(parsed.updatedAt) || blob.updatedAt || Date.now(),
  };
}

export function SettingsPrefsProvider({ children }: { children: React.ReactNode }) {
  const { identity, mode } = useIdentity();
  const [prefs, setPrefs] = useState<SettingsPrefs>(() =>
    ({ ...DEFAULT_SETTINGS_PREFS, ...LS.get<Partial<SettingsPrefs>>(SETTINGS_PREFS_KEY, {}) }));
  const existingSyncBlob = useMemo(() => LS.get<EncryptedSyncBlob | null>(SETTINGS_SYNC_BLOB_KEY, null), []);
  const syncKeyRef = useRef<CryptoKey | null>(null);
  const syncAddressRef = useRef<string | null>(existingSyncBlob?.address ?? null);
  const authSigRef = useRef<string | null>(null);
  const authSigAddressRef = useRef<string | null>(null);
  const savedMessagesRef = useRef<SettingsSyncPayload["savedMessages"]>([]);
  const pullOnSessionKeyRef = useRef(false);
  const pushTimerRef = useRef<number | null>(null);
  const [syncState, setSyncState] = useState<SettingsSyncState>({
    walletAddress: existingSyncBlob?.address ?? null,
    encryptedAt: existingSyncBlob?.updatedAt ?? null,
    hasSessionKey: false,
    isEncrypting: false,
  });

  const getAuthSig = useCallback((address: string) => {
    const addressLower = address.toLowerCase();
    if (authSigRef.current && authSigAddressRef.current === addressLower) return authSigRef.current;
    try {
      const sig = sessionStorage.getItem(`${SETTINGS_SYNC_AUTH_SIG_PREFIX}${addressLower}`);
      authSigRef.current = sig;
      authSigAddressRef.current = sig ? addressLower : null;
      return sig;
    } catch {
      return null;
    }
  }, []);

  const storeAuthSig = useCallback((address: string, signature: string) => {
    authSigAddressRef.current = address.toLowerCase();
    authSigRef.current = signature;
    try { sessionStorage.setItem(`${SETTINGS_SYNC_AUTH_SIG_PREFIX}${address.toLowerCase()}`, signature); } catch { /* */ }
  }, []);

  const pullMergePushOnce = useCallback(async (
    key: CryptoKey,
    address: string,
    localPrefs: SettingsPrefs,
    authSig?: string | null,
    repush = true,
  ): Promise<{ prefs: SettingsPrefs; blob: EncryptedSyncBlob; merged: boolean } | null> => {
    const remoteBlob = await pullRemoteBlob(address);
    if (!remoteBlob) return null;
    try {
      const remotePayload = await decryptSettingsPayload(remoteBlob as EncryptedSyncBlob, key);
      const localPayload = payloadFromPrefs(localPrefs, savedMessagesRef.current);
      const mergedPayload = mergePayload(localPayload, remotePayload);
      const mergedBlob = await encryptSyncPayload(mergedPayload, key, address);
      savedMessagesRef.current = mergedPayload.savedMessages;
      LS.set(SETTINGS_SYNC_BLOB_KEY, mergedBlob);
      if (repush && authSig) void pushBlob(address, authSig, mergedBlob);
      return { prefs: mergedPayload.settingsPrefs, blob: mergedBlob, merged: true };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => { LS.set(SETTINGS_PREFS_KEY, prefs); }, [prefs]);
  useEffect(() => {
    if (!prefs.syncAcrossDevices || !syncKeyRef.current || !syncAddressRef.current) return;
    const key = syncKeyRef.current;
    const address = syncAddressRef.current;
    let cancelled = false;
    encryptSettingsPayload(prefs, key, address, savedMessagesRef.current)
      .then((blob) => {
        if (cancelled) return;
        LS.set(SETTINGS_SYNC_BLOB_KEY, blob);
        setSyncState((s) => ({ ...s, walletAddress: blob.address, encryptedAt: blob.updatedAt, hasSessionKey: true }));
        const authSig = getAuthSig(address);
        if (!authSig) return;
        if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current);
        pushTimerRef.current = window.setTimeout(() => {
          pushTimerRef.current = null;
          pushBlob(address, authSig, blob).then(async (result) => {
            if (result.ok || !result.stale || cancelled) return;
            const merged = await pullMergePushOnce(key, address, prefs, authSig, false);
            if (!merged || cancelled) return;
            const retry = await pushBlob(address, authSig, merged.blob);
            if (retry.ok && !cancelled) {
              setPrefs(merged.prefs);
              setSyncState((s) => ({ ...s, walletAddress: merged.blob.address, encryptedAt: merged.blob.updatedAt, hasSessionKey: true }));
            }
          });
        }, 1500);
      })
      .catch(() => {
        if (!cancelled) setSyncState((s) => ({ ...s, hasSessionKey: Boolean(syncKeyRef.current) }));
      });
    return () => {
      cancelled = true;
      if (pushTimerRef.current) {
        window.clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
    };
  }, [getAuthSig, prefs, pullMergePushOnce]);

  useEffect(() => () => {
    if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current);
  }, []);

  useEffect(() => {
    if (
      pullOnSessionKeyRef.current ||
      !prefs.syncAcrossDevices ||
      !syncKeyRef.current ||
      !syncAddressRef.current ||
      !syncState.hasSessionKey
    ) return;
    pullOnSessionKeyRef.current = true;
    const key = syncKeyRef.current;
    const address = syncAddressRef.current;
    const authSig = getAuthSig(address);
    void pullMergePushOnce(key, address, prefs, authSig).then((merged) => {
      if (!merged) return;
      setPrefs(merged.prefs);
      setSyncState((s) => ({ ...s, walletAddress: merged.blob.address, encryptedAt: merged.blob.updatedAt, hasSessionKey: true }));
    });
  }, [getAuthSig, prefs, pullMergePushOnce, syncState.hasSessionKey]);

  const value = useMemo<SettingsPrefsCtx>(() => ({
    prefs,
    syncState,
    setReadReceiptsDefault: (readReceiptsDefault) => setPrefs((p) => ({ ...p, readReceiptsDefault })),
    enableSyncAcrossDevices: async () => {
      setSyncState((s) => ({ ...s, isEncrypting: true }));
      try {
        const { address, key } = await requestWalletSyncKey(mode === "wallet" ? identity.address : undefined);
        const authSig = await requestWalletSyncAuthSignature(address);
        const nextPrefs = { ...prefs, syncAcrossDevices: true };
        syncKeyRef.current = key;
        syncAddressRef.current = address;
        storeAuthSig(address, authSig);
        const remoteMerged = await pullMergePushOnce(key, address, nextPrefs, authSig, false);
        const mergedPrefs = remoteMerged?.prefs ?? nextPrefs;
        const blob = remoteMerged?.blob ?? await encryptSettingsPayload(mergedPrefs, key, address, savedMessagesRef.current);
        LS.set(SETTINGS_SYNC_BLOB_KEY, blob);
        const pushed = await pushBlob(address, authSig, blob);
        if (!pushed.ok && pushed.stale) {
          const latest = await pullMergePushOnce(key, address, mergedPrefs, authSig, false);
          if (latest) {
            await pushBlob(address, authSig, latest.blob);
            setPrefs(latest.prefs);
            setSyncState({ walletAddress: address, encryptedAt: latest.blob.updatedAt, hasSessionKey: true, isEncrypting: false });
            return { ok: true, message: "Encrypted sync is enabled for this browser session." };
          }
        }
        setPrefs(mergedPrefs);
        setSyncState({ walletAddress: address, encryptedAt: blob.updatedAt, hasSessionKey: true, isEncrypting: false });
        return { ok: true, message: "Encrypted sync is enabled for this browser session." };
      } catch (err) {
        const message = err instanceof Error && err.message
          ? err.message
          : "Wallet signature was rejected or unavailable. Sync stayed off.";
        syncKeyRef.current = null;
        syncAddressRef.current = null;
        authSigRef.current = null;
        authSigAddressRef.current = null;
        setPrefs((p) => ({ ...p, syncAcrossDevices: false }));
        setSyncState((s) => ({ ...s, hasSessionKey: false, isEncrypting: false }));
        return { ok: false, message };
      }
    },
    disableSyncAcrossDevices: () => {
      syncKeyRef.current = null;
      syncAddressRef.current = null;
      authSigRef.current = null;
      authSigAddressRef.current = null;
      LS.remove(SETTINGS_SYNC_BLOB_KEY);
      setPrefs((p) => ({ ...p, syncAcrossDevices: false }));
      setSyncState({ walletAddress: null, encryptedAt: null, hasSessionKey: false, isEncrypting: false });
    },
  }), [identity.address, mode, prefs, pullMergePushOnce, storeAuthSig, syncState]);

  return <SettingsPrefsContext.Provider value={value}>{children}</SettingsPrefsContext.Provider>;
}
export const useSettingsPrefs = () => {
  const c = useContext(SettingsPrefsContext);
  if (!c) throw new Error("useSettingsPrefs outside provider");
  return c;
};

// ====================================================================
// Chat  (binds a Transport to the active org + identity)
// ====================================================================
interface ChatCtx {
  transportId: string;
  transportStatus: string;
  transportError: string | null;
  conversations: Conversation[];
  activeId: string | null;
  activeConversation: Conversation | null;
  messages: ChatMessage[];
  enableMessaging: () => Promise<void>;
  select: (id: string | null) => void;
  send: (body: string, replyTo?: string) => Promise<void>;
  react: (messageId: string, emoji: string) => Promise<void>;
  startDm: (address: string, handle?: string) => Promise<void>;
  createRoom: (input: StartRoomInput) => Promise<void>;
  requestRoomJoin: (conversationId: string) => Promise<{ ok: boolean; message: string }>;
  setRoomPolicy: (policy: Policy) => Promise<void>;
}
const ChatContext = createContext<ChatCtx | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { identity, mode } = useIdentity();
  const { activeOrg } = useOrgs();
  const transportRef = useRef<Transport | null>(null);
  const [transportId, setTransportId] = useState("mock");
  const [transportStatus, setTransportStatus] = useState("idle");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const reloadConversations = useCallback(async () => {
    const t = transportRef.current; if (!t) return;
    setConversations(await t.listConversations());
  }, []);

  const reloadMessages = useCallback(async (id: string | null) => {
    const t = transportRef.current;
    if (!t || !id) { setMessages([]); return; }
    setMessages(await t.listMessages(id));
  }, []);

  // (Re)build the transport whenever the org or identity changes.
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    (async () => {
      const provider = mode === "wallet" ? getActiveProvider() : null;
      const t = createTransport(DEFAULT_TRANSPORT, activeOrg, identity, provider);
      setTransportError(null);
      await t.init().catch((err) => {
        setTransportError(err instanceof Error ? err.message : "Transport failed to initialize.");
      });
      if (cancelled) return;
      transportRef.current = t;
      setTransportId(t.id);
      setTransportStatus(t.status ?? "ready");
      setActiveId(null);
      setMessages([]);
      await reloadConversations();
      unsub = t.subscribe(() => {
        reloadConversations();
        setActiveId((cur) => { reloadMessages(cur); return cur; });
      });
    })();
    return () => { cancelled = true; unsub(); };
  }, [activeOrg.id, identity.address, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reloadMessages(activeId); }, [activeId, reloadMessages]);

  const select = useCallback((id: string | null) => {
    setActiveId(id);
    if (id) transportRef.current?.markRead(id);
  }, []);

  const enableMessaging = useCallback(async () => {
    const t = transportRef.current;
    if (!t?.enable) return;
    setTransportError(null);
    setTransportStatus("enabling");
    try {
      await t.enable();
      setTransportStatus(t.status ?? "ready");
      await reloadConversations();
    } catch (err) {
      setTransportStatus(t.status ?? "error");
      setTransportError(err instanceof Error ? err.message : "Messaging could not be enabled.");
    }
  }, [reloadConversations]);

  const send = useCallback(async (body: string, replyTo?: string) => {
    if (!activeId || !body.trim()) return;
    await transportRef.current?.send(activeId, body, { replyTo });
    await reloadMessages(activeId);
  }, [activeId, reloadMessages]);

  const react = useCallback(async (messageId: string, emoji: string) => {
    if (!activeId) return;
    await transportRef.current?.react(activeId, messageId, emoji);
    await reloadMessages(activeId);
  }, [activeId, reloadMessages]);

  const startDm = useCallback(async (address: string, handle?: string) => {
    const conv = await transportRef.current?.startDm(address, handle);
    await reloadConversations();
    if (conv) select(conv.id);
  }, [reloadConversations, select]);

  const createRoom = useCallback(async (input: StartRoomInput) => {
    const conv = await transportRef.current?.createRoom(input);
    await reloadConversations();
    if (conv) select(conv.id);
  }, [reloadConversations, select]);

  const requestRoomJoin = useCallback(async (conversationId: string) => {
    try {
      await transportRef.current?.requestRoomJoin?.(conversationId);
      await reloadConversations();
      return { ok: true, message: "Join request approved. Syncing room membership." };
    } catch (err) {
      const message = err instanceof Error && err.message
        ? err.message
        : "Self-serve join failed. Ask a room admin to add you.";
      return { ok: false, message };
    }
  }, [reloadConversations]);

  const setRoomPolicy = useCallback(async (policy: Policy) => {
    if (!activeId) return;
    await transportRef.current?.setRoomPolicy(activeId, policy);
    await reloadConversations();
  }, [activeId, reloadConversations]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  const value = useMemo<ChatCtx>(() => ({
    transportId, transportStatus, transportError, conversations, activeId, activeConversation, messages,
    enableMessaging, select, send, react, startDm, createRoom, requestRoomJoin, setRoomPolicy,
  }), [transportId, transportStatus, transportError, conversations, activeId, activeConversation, messages, enableMessaging, select, send, react, startDm, createRoom, requestRoomJoin, setRoomPolicy]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
export const useChat = () => {
  const c = useContext(ChatContext);
  if (!c) throw new Error("useChat outside provider");
  return c;
};
