import {decryptSettingsPayload,SyncReadError,SYNC_READ_PAUSED} from "./syncPayload";
import { loadSettings, saveSettings, withSettingsLock, assertNoRecoveryPending, recoveryMarkerKey, SettingsStorageError, SETTINGS_STORAGE_ERROR, type SettingsPrefs } from "./settingsStorage";
import { receiptOverride, receiptPreferenceKey } from "./receiptPreferences";
import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  PERSONAL_ORG, parseOrg, type Identity, type OrgConfig, type Policy,
} from "@app/core";
import {
  createTransport, parsePushConversationId, type PushMemberPage, type PushAttachment, type PushSource, type ChatMessage, type Conversation, type StartRoomInput, type Transport,
} from "@app/transport";
import { usePushRooms } from "./usePushRooms";
import { createRefreshQueue } from "./refreshQueue";
import { MAX_SAVED_ORGANIZATIONS, ORGANIZATIONS_KEY, loadOrganizationStore } from "./orgStorage";
import { APP_NAME, DEFAULT_TRANSPORT } from "./app.config";
import { resolveEns, type EnsRecord } from "./ens";
import { walletLabel, saveWalletLabel, walletProfileKey, WALLET_PROFILE_CHANGED } from "./walletProfile";
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
  createSyncAuthorization,
  revokeSyncAuthorization,
  revokeAllSyncAuthorizations,
  type SyncAuthorization,
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
  setHandle: (h: string) => Promise<void>;
  resetHandle: () => Promise<void>;
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
  handle: walletLabel(address) ?? profile?.displayName ?? profile?.name ?? undefined,
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
  const accountGenerationRef = useRef(0);
  const walletAddressRef = useRef<string | null>(null);

  const applyWalletAccount = useCallback(async (address: string) => {
    const generation = ++accountGenerationRef.current;
    const normalized = normalizeAddress(address);
    walletAddressRef.current = normalized.toLowerCase();
    setEnsProfile(null);
    setWalletIdentity(identityFromWallet(normalized));
    setMode("wallet");
    LS.set(WALLET_CONNECTED_KEY, true);
    let profile: EnsRecord | null = null;
    try {
      profile = await resolveEns(normalized);
    } catch {
      profile = null;
    }
    if (accountGenerationRef.current !== generation) return;
    setEnsProfile(profile);
    setWalletIdentity(identityFromWallet(normalized, profile));
    setMode("wallet");
    LS.set(WALLET_CONNECTED_KEY, true);
  }, []);

  const resetWalletState = useCallback(() => {
    accountGenerationRef.current++;
    walletAddressRef.current = null;
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
      resetWalletState();
    };
    ethereum.on?.("accountsChanged", onAccountsChanged);
    return () => {
      cancelled = true;
      ethereum.removeListener?.("accountsChanged", onAccountsChanged);
    };
  }, [applyWalletAccount, resetWalletState]);

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
  useEffect(() => () => { accountGenerationRef.current++; walletAddressRef.current = null; }, []);
  useEffect(() => {
    if (mode !== 'wallet') return;
    const refresh = (event: Event) => {
      if (walletAddressRef.current !== identity.address.toLowerCase()) return;
      if (event instanceof StorageEvent && event.key !== null && event.key !== walletProfileKey(identity.address)) return;
      setWalletIdentity(identityFromWallet(identity.address, ensProfile));
    };
    window.addEventListener('storage', refresh);
    window.addEventListener(WALLET_PROFILE_CHANGED, refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener(WALLET_PROFILE_CHANGED, refresh); };
  }, [mode, identity.address, ensProfile]);
  const value = useMemo<IdentityCtx>(() => ({
    identity,
    mode,
    hasInjectedWallet,
    walletConnectAvailable: walletConnectAvailable(),
    isConnecting,
    ensProfile,
    walletError,
    setHandle: async (h) => {
      if (mode === "wallet") {
        const generation = accountGenerationRef.current;
        const isCurrent = () => accountGenerationRef.current === generation && walletAddressRef.current === identity.address.toLowerCase();
        try {
          await saveWalletLabel(identity.address, h, () => { if (!isCurrent()) throw new Error('Wallet changed'); });
          if (!isCurrent()) return;
          setWalletError(null);
        } catch (error) { if (isCurrent()) setWalletError((error as Error).message); }
      } else setStubIdentity((p) => ({ ...p, handle: h }));
    },
    resetHandle: async () => {
      if (mode !== "wallet") return;
      const generation = accountGenerationRef.current;
      const isCurrent = () => accountGenerationRef.current === generation && walletAddressRef.current === identity.address.toLowerCase();
      try {
        await saveWalletLabel(identity.address, undefined, () => { if (!isCurrent()) throw new Error('Wallet changed'); });
        if (!isCurrent()) return;
        setWalletError(null);
      } catch (error) { if (isCurrent()) setWalletError((error as Error).message); }
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
  recoverySnapshots: string[];
  organizationStorageError: boolean;
  activeOrg: OrgConfig;
  activeOrgId: string;
  setActiveOrg: (id: string) => void;
  addOrg: (org: OrgConfig) => void;
  removeOrg: (id: string) => void;
}
const OrgContext = createContext<OrgCtx | null>(null);
const ACTIVE_KEY = "chat:activeOrg:v1";

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const [initialStore] = useState(() => {
    try { return { ...loadOrganizationStore(localStorage), readFailed: false }; }
    catch { return { version: 2 as const, orgs: [], recovery: [], readFailed: true }; }
  });
  const [userOrgs, setUserOrgs] = useState<OrgConfig[]>(initialStore.orgs);
  const userOrgsRef = useRef(initialStore.orgs);
  const [organizationStorageError, setOrganizationStorageError] = useState(initialStore.readFailed);
  const [activeOrgId, setActiveOrgId] = useState<string>(() => {
    const saved = LS.get<unknown>(ACTIVE_KEY, PERSONAL_ORG.id);
    return typeof saved === "string" && initialStore.orgs.some(org => org.id === saved) ? saved : PERSONAL_ORG.id;
  });

  useEffect(() => {
    if (initialStore.readFailed) return;
    try {
      localStorage.setItem(ORGANIZATIONS_KEY, JSON.stringify({ version: 2, orgs: userOrgs, recovery: initialStore.recovery }));
      setOrganizationStorageError(false);
    } catch { setOrganizationStorageError(true); }
  }, [userOrgs, initialStore]);
  useEffect(() => { LS.set(ACTIVE_KEY, activeOrgId); }, [activeOrgId]);

  const orgs = useMemo(() => [PERSONAL_ORG, ...userOrgs], [userOrgs]);
  const activeOrg = useMemo(
    () => orgs.find((o) => o.id === activeOrgId) ?? PERSONAL_ORG,
    [orgs, activeOrgId],
  );

  // Apply org branding to the document theme, including optional drop-in CSS.
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", activeOrg.branding.accent || "#F7931A");
    document.title = `${activeOrg.branding.name} · ${APP_NAME}`;
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

  const addOrg = useCallback((input: OrgConfig) => {
    if (initialStore.readFailed) throw new Error("Organization storage could not be read. Restore access before importing or creating an organization.");
    const org = parseOrg(JSON.stringify(input));
    const without = userOrgsRef.current.filter((o) => o.id !== org.id);
    if (without.length >= MAX_SAVED_ORGANIZATIONS) throw new Error("Organization limit reached. Remove an organization before adding another.");
    const next = [...without, org];
    userOrgsRef.current = next;
    setUserOrgs(next);
    setActiveOrgId(org.id);
  }, [initialStore]);

  const removeOrg = useCallback((id: string) => {
    if (id === PERSONAL_ORG.id) return;
    const next = userOrgsRef.current.filter((o) => o.id !== id);
    userOrgsRef.current = next;
    setUserOrgs(next);
    setActiveOrgId((cur) => (cur === id ? PERSONAL_ORG.id : cur));
  }, []);

  const value = useMemo<OrgCtx>(() => ({
    orgs, recoverySnapshots: initialStore.recovery, organizationStorageError, activeOrg, activeOrgId, setActiveOrg: setActiveOrgId, addOrg, removeOrg,
  }), [orgs, activeOrg, activeOrgId, addOrg, removeOrg, initialStore, organizationStorageError]);

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
  error?: string;
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
  storageError: string | null;
  storageBusy: boolean;
  recoveryPaused: boolean;
  pauseSyncForRecovery: () => void;
  refreshAfterRecovery: () => void;
  syncState: SettingsSyncState;
  setReadReceiptsDefault: (on: boolean) => Promise<void>;
  setChatReadReceipts: (conversationId: string, on: boolean | undefined) => Promise<void>;
  enableSyncAcrossDevices: () => Promise<SettingsSyncResult>;
  disableSyncAcrossDevices: () => Promise<SettingsSyncResult>;
  revokeAllSyncDevices: () => Promise<SettingsSyncResult>;
}
const SettingsPrefsContext = createContext<SettingsPrefsCtx | null>(null);
const SETTINGS_PREFS_KEY = "chat:settingsPrefs:v1";
const SETTINGS_SYNC_BLOB_KEY = "chat:settingsSyncBlob:v1";
const SETTINGS_SYNC_AUTH_SIG_PREFIX = "chirpy.sync.authSig.";

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
  if (preferredAddress && account?.toLowerCase() !== preferredAddress.toLowerCase()) throw new Error("Wallet account changed. Reconnect before enabling sync.");
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

async function signSyncMessage(address: string, message: string): Promise<string> {
  const ethereum = getActiveProvider();
  if (!ethereum) throw new Error("Connect a wallet before authorizing sync.");
  const account = accountFromResponse(await ethereum.request({ method: "eth_accounts" }));
  if (account?.toLowerCase() !== address.toLowerCase()) throw new Error("Wallet account changed. Reconnect before authorizing sync.");
  const signature = await ethereum.request({ method: "personal_sign", params: [bytesToHex(textEncoder.encode(message)), address] });
  if (typeof signature !== "string") throw new Error("Wallet did not return a signature.");
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

const payloadFromPrefs = (prefs: SettingsPrefs, savedMessages: SettingsSyncPayload["savedMessages"] = [], updatedAt = Date.now()): SettingsSyncPayload => ({
  version: 1,
  settingsPrefs: prefs,
  savedMessages,
  updatedAt,
});

async function encryptSettingsPayload(
  prefs: SettingsPrefs,
  key: CryptoKey,
  address: string,
  savedMessages: SettingsSyncPayload["savedMessages"] = [],
  updatedAt = Date.now(),
): Promise<EncryptedSyncBlob> {
  return encryptSyncPayload(payloadFromPrefs(prefs, savedMessages, updatedAt), key, address);
}

export function SettingsPrefsProvider({ children }: { children: React.ReactNode }) {
  const { identity, mode } = useIdentity();
  const scope = `${mode}:${identity.address.toLowerCase()}`;
  return <WalletSettingsPrefsProvider key={scope} scope={scope}>{children}</WalletSettingsPrefsProvider>;
}

function WalletSettingsPrefsProvider({ children, scope }: { children: React.ReactNode; scope: string }) {
  const { identity, mode } = useIdentity();
  const prefsKey = `${SETTINGS_PREFS_KEY}:${scope}`;
  const blobKey = `${SETTINGS_SYNC_BLOB_KEY}:${scope}`;
  const updatedAtKey = `chat:settingsPrefsUpdatedAt:v1:${scope}`;
  const sessionActiveRef = useRef(true);
  const ensureActive = () => { if (!sessionActiveRef.current) throw new Error("Wallet changed. Re-enable sync for the current wallet."); };
  const initialSettings = useMemo(() => loadSettings(prefsKey), []);
  const pendingAtLoad = useMemo(() => { try { return localStorage.getItem(recoveryMarkerKey(prefsKey)) !== null; } catch { return true; } }, []);
  const [recoveryPaused, setRecoveryPaused] = useState(pendingAtLoad);
  const recoveryPausedRef = useRef(pendingAtLoad);
  const suspendedPrefs = (value: SettingsPrefs): SettingsPrefs => ({ ...value, readReceiptsDefault: false,
    readReceiptOverrides: Object.fromEntries(Object.keys(value.readReceiptOverrides ?? {}).map(key => [key, false])), syncAcrossDevices: false });
  const [prefs, setPrefsState] = useState<SettingsPrefs>(pendingAtLoad ? suspendedPrefs(initialSettings.prefs) : initialSettings.prefs);
  const prefsRef = useRef(initialSettings.prefs);
  const prefsRawRef = useRef(initialSettings.raw);
  const [storageError, setStorageError] = useState<string | null>(initialSettings.failed ? SETTINGS_STORAGE_ERROR : null);
  const storageFailedRef = useRef(initialSettings.failed || pendingAtLoad);
  const pendingWrites = useRef(0);
  const [storageBusy, setStorageBusy] = useState(false);
  const existingSyncBlob = useMemo(() => LS.get<EncryptedSyncBlob | null>(blobKey, null), []);
  const legacyUpdatedAt = LS.get<number>(updatedAtKey, existingSyncBlob?.updatedAt ?? 0);
  const prefsUpdatedAtRef = useRef(initialSettings.updatedAt ||
    (Number.isSafeInteger(legacyUpdatedAt) && legacyUpdatedAt >= 0 && legacyUpdatedAt < Number.MAX_SAFE_INTEGER ? legacyUpdatedAt : 0));
  const syncKeyRef = useRef<CryptoKey | null>(null);
  const syncAddressRef = useRef<string | null>(existingSyncBlob?.address ?? null);
  const authSigRef = useRef<SyncAuthorization | null>(null);
  const authSigAddressRef = useRef<string | null>(null);
  const savedMessagesRef = useRef<SettingsSyncPayload["savedMessages"]>([]);
  // An async sync operation must never commit over a newer local choice.
  const prefsRevisionRef = useRef(0);
  const guardPrefsRevision = () => {
    const revision = prefsRevisionRef.current;
    return () => {
      ensureActive();
      try {
        assertNoRecoveryPending(prefsKey);
        if (storageFailedRef.current || localStorage.getItem(prefsKey) !== prefsRawRef.current) throw new SettingsStorageError();
      } catch {
        storageFailedRef.current = true;
        if (!recoveryPausedRef.current) setStorageError(SETTINGS_STORAGE_ERROR);
        throw new SettingsStorageError();
      }
      if (revision !== prefsRevisionRef.current) throw new Error("Settings changed while syncing. Your local choices are saved; enable sync again to retry.");
    };
  };
  const recordLocalEdit = () => {
    prefsRevisionRef.current++;
    prefsUpdatedAtRef.current = Math.max(Date.now(), prefsUpdatedAtRef.current + 1);
  };
  const setPrefs = async (next: SettingsPrefs | ((current: SettingsPrefs) => SettingsPrefs), commitGuard = ensureActive) => {
    ensureActive();
    pendingWrites.current++; setStorageBusy(true);
    try {
      await withSettingsLock(prefsKey, () => {
        ensureActive(); commitGuard();
        assertNoRecoveryPending(prefsKey);
        if (storageFailedRef.current) throw new SettingsStorageError();
        const value = typeof next === 'function' ? next(prefsRef.current) : next;
        const updatedAt = Math.max(Date.now(), Number.isSafeInteger(prefsUpdatedAtRef.current) ? prefsUpdatedAtRef.current : 0);
        const raw = saveSettings(prefsKey, prefsRawRef.current, value, updatedAt);
        prefsRawRef.current = raw; prefsUpdatedAtRef.current = updatedAt;
        const { updatedAt: _savedAt, ...committed } = JSON.parse(raw) as SettingsPrefs & { updatedAt: number };
        prefsRef.current = committed; setPrefsState(committed); setStorageError(null);
      });
    } catch (error) {
      storageFailedRef.current = true;
      if (!recoveryPausedRef.current) setStorageError(SETTINGS_STORAGE_ERROR);
      throw error;
    } finally { pendingWrites.current--; setStorageBusy(pendingWrites.current > 0); }
  };
  const stopSyncLocally = async () => {
    syncKeyRef.current = null; syncAddressRef.current = null; authSigRef.current = null; authSigAddressRef.current = null;
    try { await setPrefs(current => ({ ...current, syncAcrossDevices: false })); return true; }
    catch { const next = { ...prefsRef.current, syncAcrossDevices: false }; prefsRef.current = next; setPrefsState(recoveryPausedRef.current ? suspendedPrefs(next) : next); return false; }
  };
  const pullOnSessionKeyRef = useRef(false);
  const pushTimerRef = useRef<number | null>(null);
  const [syncState, setSyncState] = useState<SettingsSyncState>({
    walletAddress: existingSyncBlob?.address ?? null,
    encryptedAt: existingSyncBlob?.updatedAt ?? null,
    hasSessionKey: false,
    isEncrypting: false,
  });

  const getAuthSig = useCallback((address: string) => authSigAddressRef.current === address.toLowerCase() ? authSigRef.current : null, []);
  const storeAuthSig = useCallback((address: string, authorization: SyncAuthorization) => {
    authSigAddressRef.current = address.toLowerCase();
    authSigRef.current = authorization;
  }, []);

  const pushCurrentBlob = useCallback((key:CryptoKey,address:string,auth:SyncAuthorization,blob:EncryptedSyncBlob,basedOn?:EncryptedSyncBlobSnapshot) => {
    const revision=prefsRevisionRef.current;
    return pushBlob(address,auth,blob,basedOn,()=>sessionActiveRef.current&&!storageFailedRef.current&&syncKeyRef.current===key&&authSigRef.current===auth&&prefsRevisionRef.current===revision);
  }, []);

  const pullMergePushOnce = useCallback(async (
    key: CryptoKey,
    address: string,
    localPrefs: SettingsPrefs,
    authSig?: SyncAuthorization | null,
    repush = true,
  ): Promise<{ prefs: SettingsPrefs; blob: EncryptedSyncBlob; merged: boolean; basedOn: EncryptedSyncBlobSnapshot; ensureCurrent: () => void } | null> => {
    const guard = guardPrefsRevision();
    const ensureCurrent = () => {
      guard();
      if (syncKeyRef.current !== key) throw new Error("Sync authorization expired. Re-enable sync with your wallet.");
    };
    ensureCurrent();
    let remoteBlob:EncryptedSyncBlobSnapshot|null,remotePayload:SettingsSyncPayload|undefined;
    try {
      remoteBlob = await pullRemoteBlob(address);
      if (remoteBlob) remotePayload = await decryptSettingsPayload(remoteBlob, key, address);
    } catch {
      // Clear authority synchronously, before another timer or local edit can write.
      // A late failure from an old wallet/session must not pause its replacement.
      if(sessionActiveRef.current&&syncKeyRef.current===key){
        syncKeyRef.current=null;syncAddressRef.current=null;authSigRef.current=null;authSigAddressRef.current=null;
        pullOnSessionKeyRef.current=false;
        if(pushTimerRef.current){window.clearTimeout(pushTimerRef.current);pushTimerRef.current=null;}
        setSyncState(state=>({...state,hasSessionKey:false,isEncrypting:false,error:SYNC_READ_PAUSED}));
      }
      throw new SyncReadError();
    }
    ensureCurrent();
    if(!remoteBlob||!remotePayload)return null;
    try {
      const localPayload = payloadFromPrefs(localPrefs, savedMessagesRef.current, prefsUpdatedAtRef.current);
      const mergedPayload = mergePayload(localPayload, remotePayload);
      const mergedBlob = await encryptSyncPayload(mergedPayload, key, address);
      ensureCurrent();
      savedMessagesRef.current = mergedPayload.savedMessages;
      prefsUpdatedAtRef.current = mergedPayload.updatedAt;
      LS.set(blobKey, mergedBlob);
      if (repush && authSig) void pushCurrentBlob(key, address, authSig, mergedBlob, remoteBlob);
      return { prefs: mergedPayload.settingsPrefs, blob: mergedBlob, merged: true, basedOn: remoteBlob, ensureCurrent };
    } catch {
      ensureCurrent();
      throw new Error("Encrypted sync could not be decrypted. Remote data has been preserved.");
    }
  }, []);

  useEffect(() => {
    if (storageFailedRef.current || !prefs.syncAcrossDevices || !syncKeyRef.current || !syncAddressRef.current) return;
    const key = syncKeyRef.current;
    const address = syncAddressRef.current;
    let cancelled = false;
    encryptSettingsPayload(prefs, key, address, savedMessagesRef.current, prefsUpdatedAtRef.current)
      .then((blob) => {
        if (cancelled || storageFailedRef.current || syncKeyRef.current !== key) return;
        LS.set(blobKey, blob);
        setSyncState((s) => ({ ...s, walletAddress: blob.address, encryptedAt: blob.updatedAt, hasSessionKey: true }));
        const authSig = getAuthSig(address);
        if (!authSig) return;
        if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current);
        pushTimerRef.current = window.setTimeout(() => {
          pushTimerRef.current = null;
          if (cancelled || storageFailedRef.current || syncKeyRef.current !== key) return;
          pushCurrentBlob(key, address, authSig, blob).then(async (result) => {
            if (cancelled || storageFailedRef.current || syncKeyRef.current !== key) return;
            if (result.ok) { setSyncState((s) => ({ ...s, error: undefined })); return; }
            if (!result.stale) throw new Error("Sync write failed");
            const merged = await pullMergePushOnce(key, address, prefs, authSig, false);
            if (!merged || cancelled) return;
            const retry = await pushCurrentBlob(key, address, authSig, merged.blob, merged.basedOn);
            if (!retry.ok) throw new Error("Sync conflict; retry required");
            if (!cancelled) {
              await setPrefs(merged.prefs, merged.ensureCurrent);
              merged.ensureCurrent();
              setSyncState((s) => ({ ...s, walletAddress: merged.blob.address, encryptedAt: merged.blob.updatedAt, hasSessionKey: true }));
            }
          }).catch(() => { if(syncKeyRef.current===key)setSyncState((s) => ({ ...s, error: "Sync failed. Local changes are saved on this device; retry sync when available." })); });
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

  useEffect(() => {
    if (!storageError) return;
    syncKeyRef.current = null; authSigRef.current = null;
    if (pushTimerRef.current) { window.clearTimeout(pushTimerRef.current); pushTimerRef.current = null; }
    setSyncState(state => ({ ...state, hasSessionKey: false, isEncrypting: false }));
  }, [storageError]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== recoveryMarkerKey(prefsKey) || event.newValue === null) return;
      prefsRevisionRef.current++; storageFailedRef.current = true;
      syncKeyRef.current = null; authSigRef.current = null;
      if (pushTimerRef.current) { window.clearTimeout(pushTimerRef.current); pushTimerRef.current = null; }
      recoveryPausedRef.current = true; setRecoveryPaused(true);
      setPrefsState(suspendedPrefs(prefsRef.current));
    };
    window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed);
  }, []);

  useEffect(() => {
    sessionActiveRef.current = true;
    return () => {
      sessionActiveRef.current = false;
      syncKeyRef.current = null;
      authSigRef.current = null;
      try { sessionStorage.removeItem(`${SETTINGS_SYNC_AUTH_SIG_PREFIX}${identity.address.toLowerCase()}`); } catch { /* Ignore disabled storage. */ }
      if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (
      storageFailedRef.current ||
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
    void pullMergePushOnce(key, address, prefs, authSig).then(async (merged) => {
      if (!merged) return;
      await setPrefs(merged.prefs, merged.ensureCurrent);
      merged.ensureCurrent();
      setSyncState((s) => ({ ...s, walletAddress: merged.blob.address, encryptedAt: merged.blob.updatedAt, hasSessionKey: true }));
    }).catch(() => { if(syncKeyRef.current===key)setSyncState((s) => ({ ...s, error: "Remote sync could not be read. Local data is unchanged." })); });
  }, [getAuthSig, prefs, pullMergePushOnce, syncState.hasSessionKey]);

  useEffect(() => {
    const authorization = authSigRef.current;
    if (!syncState.hasSessionKey || !authorization) return;
    const expire = () => {
      syncKeyRef.current = null;
      authSigRef.current = null;
      setSyncState((state) => ({ ...state, hasSessionKey: false, error: "Sync authorization expired. Re-enable sync with your wallet." }));
    };
    const timeout = window.setTimeout(expire, Math.max(0, authorization.grant.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [syncState.hasSessionKey]);

  const value = useMemo<SettingsPrefsCtx>(() => ({
    prefs: recoveryPaused ? suspendedPrefs(prefs) : prefs,
    storageError, storageBusy, recoveryPaused,
    pauseSyncForRecovery: () => {
      ensureActive(); prefsRevisionRef.current++;
      storageFailedRef.current = true; recoveryPausedRef.current = true; setRecoveryPaused(true);
      syncKeyRef.current = null; syncAddressRef.current = null; authSigRef.current = null; authSigAddressRef.current = null;
      if (pushTimerRef.current) { window.clearTimeout(pushTimerRef.current); pushTimerRef.current = null; }
      setPrefsState(suspendedPrefs(prefsRef.current));
      setSyncState(state => ({ ...state, hasSessionKey: false, isEncrypting: false }));
    },
    refreshAfterRecovery: () => {
      ensureActive(); assertNoRecoveryPending(prefsKey); const loaded = loadSettings(prefsKey);
      if (loaded.failed) throw new SettingsStorageError();
      prefsRevisionRef.current++; prefsRawRef.current = loaded.raw; prefsRef.current = loaded.prefs;
      prefsUpdatedAtRef.current = loaded.updatedAt; storageFailedRef.current = false;
      recoveryPausedRef.current = false; setRecoveryPaused(false);
      setPrefsState(loaded.prefs); setStorageError(null);
    },
    syncState,
    setReadReceiptsDefault: async (readReceiptsDefault) => {
      recordLocalEdit();
      try { await setPrefs((p) => ({ ...p, readReceiptsDefault })); } catch { /* Visible storage error; committed settings remain selected. */ }
    },
    setChatReadReceipts: async (conversationId, on) => {
      if (!/^[a-zA-Z0-9_-]{1,256}$/.test(conversationId) || (on !== undefined && typeof on !== "boolean")) return;
      recordLocalEdit();
      try { await setPrefs((current) => {
        const overrides = { ...current.readReceiptOverrides };
        const key = receiptPreferenceKey(conversationId);
        if (on === undefined) delete overrides[key]; else overrides[key] = on;
        return { ...current, readReceiptOverrides: overrides };
      }); } catch { /* Visible storage error; do not claim this change was saved. */ }
    },
    enableSyncAcrossDevices: async () => {
      if (mode !== "wallet") return { ok: false, message: "Connect a wallet before enabling encrypted sync." };
      if (storageFailedRef.current) return { ok: false, message: SETTINGS_STORAGE_ERROR };
      const ensureCurrent = guardPrefsRevision();
      setSyncState((s) => ({ ...s, isEncrypting: true }));
      try {
        const { address, key } = await requestWalletSyncKey(mode === "wallet" ? identity.address : undefined);
        ensureCurrent();
        const authSig = await createSyncAuthorization(address, (message) => { ensureCurrent(); return signSyncMessage(address, message); });
        ensureCurrent();
        const nextPrefs = { ...prefs, syncAcrossDevices: true };
        pullOnSessionKeyRef.current=false;
        syncKeyRef.current = key;
        syncAddressRef.current = address;
        storeAuthSig(address, authSig);
        const remoteMerged = await pullMergePushOnce(key, address, nextPrefs, authSig, false);
        const mergedPrefs = { ...(remoteMerged?.prefs ?? nextPrefs), syncAcrossDevices: true };
        const blob = remoteMerged?.blob ?? await encryptSettingsPayload(mergedPrefs, key, address, savedMessagesRef.current);
        ensureCurrent();
        LS.set(blobKey, blob);
        const pushed = await pushCurrentBlob(key, address, authSig, blob, remoteMerged?.basedOn);
        ensureCurrent();
        if (!pushed.ok && pushed.stale) {
          const latest = await pullMergePushOnce(key, address, mergedPrefs, authSig, false);
          if (latest) {
            const retry = await pushCurrentBlob(key, address, authSig, latest.blob, latest.basedOn);
            ensureCurrent();
            if (!retry.ok) throw new Error("Another device changed sync again. Try enabling sync again.");
            await setPrefs(latest.prefs, ensureCurrent);
            ensureCurrent();
            setSyncState({ walletAddress: address, encryptedAt: latest.blob.updatedAt, hasSessionKey: true, isEncrypting: false });
            return { ok: true, message: "Encrypted sync is enabled for this browser session, for up to 24 hours." };
          }
        }
        if (!pushed.ok) throw new Error("Encrypted sync was not saved. Try again; local data has been kept.");
        await setPrefs(mergedPrefs, ensureCurrent);
        ensureCurrent();
        setSyncState({ walletAddress: address, encryptedAt: blob.updatedAt, hasSessionKey: true, isEncrypting: false });
        return { ok: true, message: "Encrypted sync is enabled for this browser session, for up to 24 hours." };
      } catch (err) {
        const message = err instanceof Error && err.message
          ? err.message
          : "Wallet signature was rejected or unavailable. Sync stayed off.";
        syncKeyRef.current = null;
        syncAddressRef.current = null;
        authSigRef.current = null;
        authSigAddressRef.current = null;
        await stopSyncLocally();
        setSyncState((s) => ({ ...s, hasSessionKey: false, isEncrypting: false }));
        return { ok: false, message };
      }
    },
    disableSyncAcrossDevices: async () => {
      recordLocalEdit();
      const authorization = authSigRef.current;
      syncKeyRef.current = null;
      syncAddressRef.current = null;
      authSigRef.current = null;
      authSigAddressRef.current = null;
      LS.remove(blobKey);
      const saved = await stopSyncLocally();
      setSyncState({ walletAddress: null, encryptedAt: null, hasSessionKey: false, isEncrypting: false });
      try {
        if (authorization) await revokeSyncAuthorization(authorization);
        if (!saved) return { ok: false, message: "Sync stopped for this session, but the local preference could not be saved. Restore browser storage before reloading." };
        return { ok: true, message: authorization ? "Sync is off and this device authorization was revoked." : "Sync is off locally. Use Revoke all sync devices to revoke earlier sessions." };
      } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Sync stopped locally; revocation was not confirmed." }; }
    },
    revokeAllSyncDevices: async () => {
      if (mode !== "wallet") return { ok: false, message: "Connect a wallet to revoke sync devices." };
      recordLocalEdit();
      setSyncState((state) => ({ ...state, isEncrypting: true }));
      try {
        await revokeAllSyncAuthorizations(identity.address, (message) => { ensureActive(); return signSyncMessage(identity.address, message); });
        ensureActive();
        syncKeyRef.current = null; syncAddressRef.current = null; authSigRef.current = null; authSigAddressRef.current = null;
        const saved = await stopSyncLocally();
        setSyncState({ walletAddress: null, encryptedAt: null, hasSessionKey: false, isEncrypting: false });
        if (!saved) return { ok: false, message: "Sync authorizations were revoked, but the local preference could not be saved. Restore browser storage before reloading." };
        return { ok: true, message: "All existing sync device authorizations were revoked. Your encrypted saved data is retained." };
      } catch (error) {
        setSyncState((state) => ({ ...state, isEncrypting: false }));
        return { ok: false, message: error instanceof Error ? error.message : "Revocation was not confirmed. Retry when connected." };
      }
    },
  }), [identity.address, mode, prefs, pullMergePushOnce, storeAuthSig, syncState, storageError, storageBusy, recoveryPaused]);

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
  pushSource: PushSource | null;
  setPushSource: (source: PushSource | null) => void;
  pushStatus: string;
  pushLoading: boolean;
  pushError: string | null;
  enablePushRooms: () => Promise<void>;
  refreshPushRooms: () => Promise<void>;
  leavePushRoom: () => Promise<void>;
  managePushMember: (action: 'add' | 'remove', address: string, role: 'ADMIN' | 'MEMBER') => Promise<void>;
  loadPushMembers: (page: number, pending: boolean) => Promise<PushMemberPage>;
  historyError: string | null;
  transportId: string;
  transportStatus: string;
  transportError: string | null;
  /** True when enabling failed because the inbox is at XMTP's 10-installation limit. */
  transportNeedsRevoke: boolean;
  conversations: Conversation[];
  activeId: string | null;
  activeConversation: Conversation | null;
  messages: ChatMessage[];
  historyLoading: boolean;
  isHistory: boolean;
  hasOlderMessages: boolean;
  navigateHistory: (direction: "older" | "newer" | "latest" | "refresh") => void;
  enableMessaging: (opts?: { revokeStale?: boolean }) => Promise<void>;
  requestHistorySync: () => Promise<void>;
  select: (id: string | null) => void;
  markRead: (throughMessageId: string) => Promise<void>;
  send: (body: string, replyTo?: string, files?: PushAttachment[]) => Promise<void>;
  react: (messageId: string, emoji: string) => Promise<void>;
  startDm: (address: string, handle?: string) => Promise<void>;
  createRoom: (input: StartRoomInput) => Promise<void>;
  addRoomMember: (address: string) => Promise<void>;
  requestRoomJoin: (conversationId: string) => Promise<{ ok: boolean; message: string }>;
  setRoomPolicy: (policy: Policy) => Promise<void>;
  setConversationConsent: (state: "allowed" | "denied") => Promise<void>;
}
const ChatContext = createContext<ChatCtx | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { prefs } = useSettingsPrefs();
  const { identity, mode } = useIdentity();
  const { activeOrg } = useOrgs();
  const transportRef = useRef<Transport | null>(null);
  const [transportId, setTransportId] = useState("mock");
  const [transportStatus, setTransportStatus] = useState("idle");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [transportNeedsRevoke, setTransportNeedsRevoke] = useState(false);
  const [nativeConversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // A distinct scope object also cancels additions after leaving and returning to the same room.
  const memberScopeKey = `${mode}:${identity.address.toLowerCase()}:${activeOrg.namespace}:${activeId ?? ''}`;
  const memberScopeRef = useRef({ key: memberScopeKey });
  if (memberScopeRef.current.key !== memberScopeKey) memberScopeRef.current = { key: memberScopeKey };
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<{ before?: string; newer: (string | undefined)[] }>({ newer: [] });
  const historyRef = useRef(history);
  const [olderCursor, setOlderCursor] = useState<string>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const resetHistory = useCallback(() => {
    historyRef.current = { newer: [] }; setHistory(historyRef.current); setOlderCursor(undefined);
  }, []);

  const conversationLoadRef = useRef(0);
  const messageLoadRef = useRef(0);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const invalidatePushView = useCallback((available?: ReadonlySet<string>) => {
    if (activeIdRef.current && parsePushConversationId(activeIdRef.current) && (!available || !available.has(activeIdRef.current))) {
      messageLoadRef.current++; activeIdRef.current = null; setActiveId(null);
      setMessages([]); setHistoryError(null); setHistoryLoading(false); resetHistory();
    }
  }, [resetHistory]);
  const push = usePushRooms(identity.address, mode === 'wallet', activeOrg.id, invalidatePushView);
  const { getAdapter: getPushAdapter } = push;
  const conversations = useMemo(() => [...nativeConversations, ...push.snapshot.rooms], [nativeConversations, push.snapshot.rooms]);
  const reloadConversations = useCallback(async () => {
    const request = ++conversationLoadRef.current;
    const t = transportRef.current; if (!t) return;
    try {
      const next = await t.listConversations();
      if (transportRef.current === t && conversationLoadRef.current === request) { setConversations(next); setTransportError(t.warning ?? null); }
    } catch (error) { if (transportRef.current === t && conversationLoadRef.current === request) setTransportError(error instanceof Error ? error.message : "Unable to load conversations."); }
  }, []);

  const reloadMessages = useCallback(async (id: string | null) => {
    if (id !== activeIdRef.current) return;
    const request = ++messageLoadRef.current;
    const t = transportRef.current;
    const isPush = !!id && !!parsePushConversationId(id);
    const rooms = isPush ? getPushAdapter() : null;
    if (!id || (isPush ? !rooms || rooms.getSnapshot().status !== 'ready' : !t)) {
      setMessages([]); setOlderCursor(undefined); setHistoryLoading(false); return;
    }
    const before = historyRef.current.before;
    const current = () => messageLoadRef.current === request && activeIdRef.current === id && historyRef.current.before === before
      && (isPush ? getPushAdapter() === rooms : transportRef.current === t);
    setHistoryLoading(true); setHistoryError(null);
    try {
      const page = isPush ? await rooms!.history(id, before) : await t!.listMessagePage(id, before);
      if (current()) { setMessages(page.messages); setOlderCursor(page.olderCursor); }
    } catch (error) {
      if (current()) { setHistoryError(error instanceof Error ? error.message : "Unable to load messages."); if (isPush) setMessages([]); }
    } finally { if (messageLoadRef.current === request) setHistoryLoading(false); }
  }, [getPushAdapter]);

  const navigateHistory = useCallback((direction: "older" | "newer" | "latest" | "refresh") => {
    const current = historyRef.current;
    let next = current;
    if (direction === "older") {
      if (!olderCursor) return;
      next = { before: olderCursor, newer: [...current.newer, current.before] };
    } else if (direction === "newer") {
      if (!current.newer.length) return;
      next = { before: current.newer.at(-1), newer: current.newer.slice(0, -1) };
    } else if (direction === "latest") next = { newer: [] };
    historyRef.current = next; setHistory(next); setOlderCursor(undefined); setMessages([]);
    void reloadMessages(activeIdRef.current);
  }, [olderCursor, reloadMessages]);

  // (Re)build the transport whenever the org or identity changes.
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    transportRef.current = null;
    setConversations([]);
    setMessages([]);
    setActiveId(null);
    activeIdRef.current = null; resetHistory();
    messageLoadRef.current++;
    (async () => {
      const provider = mode === "wallet" ? getActiveProvider() : null;
      const t = createTransport(DEFAULT_TRANSPORT, activeOrg, identity, provider);
      setTransportError(null);
      await t.init().catch((err) => {
        if (!cancelled) setTransportError(err instanceof Error ? err.message : "Transport failed to initialize.");
      });
      if (cancelled) return;
      transportRef.current = t;
      setTransportId(t.id);
      setTransportStatus(t.status ?? "ready");
      // Initial scope reset happened before init. A Push room may have opened
      // while the independent native transport was still initializing.
      await reloadConversations();
      if (cancelled) return;
      const queue = createRefreshQueue(async () => {
        if (cancelled || document.visibilityState === "hidden") return;
        await reloadConversations();
        const selected = activeIdRef.current;
        if (!cancelled && selected && !parsePushConversationId(selected)) await reloadMessages(selected);
      }, (error) => {
        if (!cancelled) setTransportError(error instanceof Error ? error.message : "Unable to refresh chats.");
      });
      const stop = t.subscribe(queue.notify);
      unsub = () => { queue.cancel(); stop(); };
    })();
    return () => { cancelled = true; unsub(); };
  }, [activeOrg.id, identity.address, mode, push.connectionRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reloadMessages(activeId); }, [activeId, reloadMessages]);

  const select = useCallback((id: string | null) => {
    const reselected = id === activeIdRef.current;
    activeIdRef.current = id;
    messageLoadRef.current++;
    resetHistory(); setMessages([]); setHistoryError(null);
    setActiveId(id);
    if (reselected) void reloadMessages(id);
  }, [resetHistory, reloadMessages]);

  const markRead = useCallback(async (throughMessageId: string) => {
    if (!activeId || parsePushConversationId(activeId)) return;
    await transportRef.current?.markRead(activeId, { sendReceipt: receiptOverride(prefs.readReceiptOverrides, activeId) ?? prefs.readReceiptsDefault, throughMessageId });
  }, [activeId, prefs.readReceiptsDefault, prefs.readReceiptOverrides]);

  const enableMessaging = useCallback(async (opts?: { revokeStale?: boolean }) => {
    const t = transportRef.current;
    if (!t?.enable) return;
    setTransportError(null);
    setTransportNeedsRevoke(false);
    setTransportStatus("enabling");
    try {
      await t.enable(opts);
      if (transportRef.current !== t) return;
      setTransportStatus(t.status ?? "ready");
      await reloadConversations();
    } catch (err) {
      if (transportRef.current !== t) return;
      setTransportStatus(t.status ?? "error");
      setTransportError(err instanceof Error ? err.message : "Messaging could not be enabled.");
      if ((err as { code?: string })?.code === "installation_limit") setTransportNeedsRevoke(true);
    }
  }, [reloadConversations]);

  const requestHistorySync = useCallback(async () => {
    const transport = transportRef.current;
    if (!transport?.requestHistorySync || transport.status !== 'ready') throw new Error('Messaging is not ready.');
    await transport.requestHistorySync();
    if (transportRef.current !== transport) throw new Error('Wallet or organization changed.');
    // SDK background sync and the normal stream/poll refresh pick up the archive later.
  }, []);

  const send = useCallback(async (body: string, replyTo?: string, files?: PushAttachment[]) => {
    if (!activeId || (!body.trim() && !files?.length)) return;
    if (parsePushConversationId(activeId)) {
      const rooms = getPushAdapter(); if (!rooms) throw new Error('Push rooms are reconnecting.');
      await rooms.send(activeId, body, { replyTo, files });
      if (getPushAdapter() !== rooms) throw new Error('Room connection changed. Check history before retrying.');
      if (activeIdRef.current === activeId) { resetHistory(); await reloadMessages(activeId); }
      return;
    }
    if (files?.length) throw new Error("File sending is available in Push rooms only.");
    if (!transportRef.current) throw new Error("Messaging is reconnecting. Try again shortly.");
    const transport = transportRef.current;
    await transport.send(activeId, body, { replyTo });
    if (activeIdRef.current !== activeId || transportRef.current !== transport) return;
    resetHistory(); await reloadMessages(activeId);
  }, [activeId, reloadMessages, resetHistory, getPushAdapter]);

  const react = useCallback(async (messageId: string, emoji: string) => {
    if (!activeId) return;
    if (parsePushConversationId(activeId)) {
      const rooms = getPushAdapter(); if (!rooms) throw new Error('Push rooms are reconnecting.');
      await rooms.react(activeId, messageId, emoji);
      if (getPushAdapter() !== rooms) throw new Error('Room connection changed. Check history before retrying.');
      if (activeIdRef.current === activeId) { resetHistory(); await reloadMessages(activeId); }
      return;
    }
    const transport = transportRef.current;
    if (!transport) throw new Error('Messaging is reconnecting. Try again shortly.');
    await transport.react(activeId, messageId, emoji);
    if (activeIdRef.current !== activeId || transportRef.current !== transport) return;
    await reloadMessages(activeId);
  }, [activeId, reloadMessages, resetHistory, getPushAdapter]);

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

  const addRoomMember = useCallback(async (address: string) => {
    const id = activeIdRef.current; const transport = transportRef.current;
    if (!id || parsePushConversationId(id) || !transport?.addRoomMember) throw new Error('Room member additions are unavailable.');
    const scope = memberScopeRef.current;
    const isCurrent = () => transportRef.current === transport && activeIdRef.current === id && memberScopeRef.current === scope;
    await transport.addRoomMember(id, address, isCurrent);
    if (!isCurrent()) throw new Error('Wallet or room changed. Check members before retrying.');
    await reloadConversations();
  }, [reloadConversations]);

  const requestRoomJoin = useCallback(async (conversationId: string) => {
    try {
      if (parsePushConversationId(conversationId)) {
        const rooms = getPushAdapter(); if (!rooms) throw new Error('Enable Push rooms first.');
        const result = await rooms.join(conversationId);
        await reloadMessages(conversationId);
        return { ok: result.membership === 'member', message: result.membership === 'member' ? 'You joined the Push room.' : 'Membership is pending approval.' };
      }
      if (!transportRef.current?.requestRoomJoin) throw new Error('Room joining is unavailable.');
      await transportRef.current.requestRoomJoin(conversationId);
      await reloadConversations();
      return { ok: true, message: "Join request approved. Syncing room membership." };
    } catch (err) {
      const message = err instanceof Error && err.message
        ? err.message
        : "Self-serve join failed. Ask a room admin to add you.";
      return { ok: false, message };
    }
  }, [reloadConversations, reloadMessages, getPushAdapter]);

  const setRoomPolicy = useCallback(async (policy: Policy) => {
    if (!activeId) return;
    if (parsePushConversationId(activeId)) throw new Error('Push room policy remains with the original room.');
    await transportRef.current?.setRoomPolicy(activeId, policy);
    await reloadConversations();
  }, [activeId, reloadConversations]);

  const setConversationConsent = useCallback(async (state: "allowed" | "denied") => {
    const transport = transportRef.current; const id = activeIdRef.current;
    if (!id || !transport || parsePushConversationId(id)) throw new Error("Messaging is reconnecting. Try again shortly.");
    const scope = memberScopeRef.current;
    const isCurrent = () => transportRef.current === transport && activeIdRef.current === id && memberScopeRef.current === scope;
    await transport.setConversationConsent(id, state, isCurrent);
    if (!isCurrent()) return;
    if (state === "denied") {
      ++messageLoadRef.current;
      setMessages([]); resetHistory();
      setConversations(current => current.map(c => c.id === id ? { ...c, pending: false, blocked: true, lastMessage: undefined, unread: 0 } : c));
    }
    await reloadConversations();
    if (isCurrent()) await reloadMessages(id);
  }, [reloadConversations, reloadMessages, resetHistory]);

  const enablePushRooms = useCallback(async () => {
    await push.enable();
    if (activeIdRef.current && parsePushConversationId(activeIdRef.current)) await reloadMessages(activeIdRef.current);
  }, [push.enable, reloadMessages]);
  const leavePushRoom = useCallback(async () => {
    const id = activeIdRef.current; const rooms = getPushAdapter();
    if (!id || !parsePushConversationId(id) || !rooms) throw new Error('Select a connected Push room.');
    await rooms.leave(id);
    if (getPushAdapter() === rooms && activeIdRef.current === id) { setMessages([]); resetHistory(); await reloadMessages(id); }
  }, [getPushAdapter, reloadMessages, resetHistory]);
  const managePushMember = useCallback(async (action: 'add' | 'remove', address: string, role: 'ADMIN' | 'MEMBER') => {
    const id = activeIdRef.current; const rooms = getPushAdapter();
    if (!id || !parsePushConversationId(id) || !rooms) throw new Error('Select a connected Push room.');
    await rooms.moderate(id, action, address, role);
  }, [getPushAdapter]);
  const loadPushMembers = useCallback(async (page: number, pending: boolean) => {
    const id = activeIdRef.current; const rooms = getPushAdapter();
    if (!id || !parsePushConversationId(id) || !rooms) throw new Error('Select a connected Push room.');
    const result = await rooms.members(id, page, pending);
    if (getPushAdapter() !== rooms || activeIdRef.current !== id) throw new Error('Room connection changed. Refresh members.');
    return result;
  }, [getPushAdapter]);
  useEffect(() => {
    if (!activeId || !parsePushConversationId(activeId) || push.snapshot.status !== 'ready') return;
    const queue = createRefreshQueue(async () => {
      if (document.visibilityState !== 'hidden' && navigator.onLine && historyRef.current.before === undefined) await reloadMessages(activeIdRef.current);
    }, () => {});
    const notify = () => queue.notify();
    const timer = setInterval(notify, 15_000);
    window.addEventListener('online', notify); document.addEventListener('visibilitychange', notify);
    return () => { clearInterval(timer); queue.cancel(); window.removeEventListener('online', notify); document.removeEventListener('visibilitychange', notify); };
  }, [activeId, push.snapshot.status, reloadMessages]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  const pushReadDenied = Boolean(activeConversation?.push && (push.snapshot.status !== 'ready'
    || (!activeConversation.push.publicRoom && activeConversation.push.membership !== 'member')));
  // Permission changes can be discovered by any action, not only a history read.
  // Mask immediately during render, then discard the cached page. In-flight
  // reads retain their own session/access checks before they may publish.
  useEffect(() => {
    if (pushReadDenied) { if (messages.length) setMessages([]); setOlderCursor(undefined); }
  }, [pushReadDenied, messages.length]);

  const value = useMemo<ChatCtx>(() => ({
    pushSource: push.source, setPushSource: push.changeSource, pushStatus: push.snapshot.status, pushLoading: push.snapshot.loading,
    pushError: push.error ?? push.snapshot.error ?? null, enablePushRooms, refreshPushRooms: push.refresh, leavePushRoom, managePushMember, loadPushMembers, historyError,
    transportId, transportStatus, transportError, transportNeedsRevoke, conversations, activeId, activeConversation, messages: pushReadDenied ? [] : messages,
    historyLoading, isHistory: history.before !== undefined, hasOlderMessages: !pushReadDenied && olderCursor !== undefined, navigateHistory,
    enableMessaging, requestHistorySync, select, markRead, send, react, startDm, createRoom, addRoomMember, requestRoomJoin, setRoomPolicy, setConversationConsent,
  }), [push.source, push.changeSource, push.snapshot, push.error, push.refresh, enablePushRooms, leavePushRoom, managePushMember, loadPushMembers, historyError, pushReadDenied, transportId, transportStatus, transportError, transportNeedsRevoke, conversations, activeId, activeConversation, messages, historyLoading, history, olderCursor, navigateHistory, enableMessaging, requestHistorySync, select, markRead, send, react, startDm, createRoom, addRoomMember, requestRoomJoin, setRoomPolicy, setConversationConsent]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
export const useChat = () => {
  const c = useContext(ChatContext);
  if (!c) throw new Error("useChat outside provider");
  return c;
};
