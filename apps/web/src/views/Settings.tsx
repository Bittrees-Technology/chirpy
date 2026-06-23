import React, { useEffect, useMemo, useState } from "react";
import { serializeOrg, type RoomRule } from "@app/core";
import { useChat, useIdentity, useOrgs, useSettingsPrefs } from "../state";
import { Avatar, Button, Field, Toggle, shortAddr } from "../ui";
import { download } from "./dialogs";
import { UpdateCard } from "./UpdateCard";
import { useI18n, LANGS, type LangCode } from "../i18n";
import { isAddress, isEnsName, resolveEns, type EnsRecord } from "../ens";

function gateSummary(rules: RoomRule[]): string {
  if (!rules.length) return "open";
  return `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
}

export function Settings(
  { onCreateOrg, onImportOrg }: { onCreateOrg: () => void; onImportOrg: () => void },
) {
  const {
    identity, mode, hasInjectedWallet, walletConnectAvailable, isConnecting, ensProfile, walletError,
    setHandle, reset, connectWallet, connectWalletConnect, disconnectWallet,
  } = useIdentity();
  const { orgs, activeOrg, activeOrgId, setActiveOrg, removeOrg } = useOrgs();
  const { prefs, syncState, setReadReceiptsDefault, enableSyncAcrossDevices, disableSyncAcrossDevices } = useSettingsPrefs();
  const { transportId, transportStatus, transportError, transportNeedsRevoke, enableMessaging } = useChat();
  const { lang, setLang, t } = useI18n();
  const [profileEns, setProfileEns] = useState<EnsRecord | null>(null);
  const [resolverInput, setResolverInput] = useState("");
  const [resolverState, setResolverState] = useState<"idle" | "loading" | "success" | "neutral" | "error">("idle");
  const [resolverText, setResolverText] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const [syncMessageKind, setSyncMessageKind] = useState<"success" | "error" | "neutral">("neutral");

  const profileLookup = useMemo(() => {
    const handle = identity.handle?.trim() ?? "";
    return isEnsName(handle) ? handle : identity.address;
  }, [identity.address, identity.handle]);

  useEffect(() => {
    let cancelled = false;
    setProfileEns(null);
    (async () => {
      try {
        const record = await resolveEns(profileLookup);
        if (record.address && record.avatar) {
          try {
            const avatarRes = await fetch(record.avatar, { method: "HEAD" });
            if (!avatarRes.ok) record.avatar = null;
          } catch {
            record.avatar = null;
          }
        }
        if (!cancelled) setProfileEns(record);
      } catch {
        if (!cancelled) setProfileEns(null);
      }
    })();
    return () => { cancelled = true; };
  }, [profileLookup]);

  useEffect(() => {
    let cancelled = false;
    const query = resolverInput.trim();
    if (!query) {
      setResolverState("idle");
      setResolverText("");
      return undefined;
    }

    const timer = window.setTimeout(() => {
      if (!isEnsName(query) && !isAddress(query)) {
        setResolverState("neutral");
        setResolverText("Enter a .eth name or a 0x address.");
        return;
      }

      setResolverState("loading");
      setResolverText("Checking ENS...");
      resolveEns(query)
        .then((record) => {
          if (cancelled) return;
          if (isEnsName(query)) {
            if (record.address) {
              setResolverState("success");
              setResolverText(`${record.displayName ?? record.name ?? query} resolves to ${record.address}.`);
            } else {
              setResolverState("neutral");
              setResolverText(`${query} is available or does not currently resolve.`);
            }
            return;
          }

          if (record.name) {
            setResolverState("success");
            setResolverText(`${shortAddr(query)} reverse-resolves to ${record.name}.`);
          } else {
            setResolverState("neutral");
            setResolverText("No primary ENS name found for this address.");
          }
        })
        .catch(() => {
          if (cancelled) return;
          setResolverState("error");
          setResolverText("ENS lookup unavailable. Try again later.");
        });
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [resolverInput]);

  const activeProfile = mode === "wallet" ? ensProfile ?? profileEns : profileEns;
  const ensName = activeProfile?.name ?? (isEnsName(identity.handle ?? "") ? identity.handle : undefined);
  const profileName = activeProfile?.displayName ?? ensName ?? identity.handle ?? shortAddr(identity.address);
  const profileAvatar = activeProfile?.address && activeProfile.avatar ? activeProfile.avatar : undefined;
  const ensManagerTarget = ensName ?? identity.address;
  const syncDescription = prefs.syncAcrossDevices
    ? syncState.walletAddress
      ? `On - encrypted locally for ${shortAddr(syncState.walletAddress)}. Cross-device delivery starts when the sync relay is connected.`
      : "On - encrypted locally. Cross-device delivery starts when the sync relay is connected."
    : "Off - stored only on this device. Turn on to encrypt them to your wallet and sync across devices (two signatures, no gas).";
  const transportText = transportId === "mock"
    ? "Mock mode: local chats on this device."
    : "XMTP mode: encrypted DMs and rooms.";
  const handleSyncClick = async () => {
    setSyncMessage("");
    setSyncMessageKind("neutral");
    if (prefs.syncAcrossDevices) {
      disableSyncAcrossDevices();
      setSyncMessage("Encrypted sync is off. Preferences are local-only on this device.");
      setSyncMessageKind("neutral");
      return;
    }
    const result = await enableSyncAcrossDevices();
    setSyncMessage(result.message);
    setSyncMessageKind(result.ok ? "success" : "error");
  };

  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="card">
        <div className="profile-row">
          <div className="profile-main">
            <Avatar id={identity.address} label={profileName} src={profileAvatar} size={64} />
            <div>
              <h2>Profile</h2>
              <div className="profile-name">{profileName}</div>
              <div className="muted">{shortAddr(identity.address)}</div>
            </div>
          </div>
          <Button
            variant="ghost"
            onClick={() => window.open(`https://app.ens.domains/${encodeURIComponent(ensManagerTarget)}`, "_blank", "noopener,noreferrer")}
          >
            Change picture ↗
          </Button>
        </div>
        {profileAvatar && ensName ? (
          <p className="muted status-line status-positive">✓ Picture set on ENS — {ensName}. Shown across every app.</p>
        ) : (
          <p className="muted status-line">Set your profile picture on ENS to show the same avatar across apps.</p>
        )}
      </section>

      <section className="card">
        <h2>Account</h2>
        <p className="muted">
          {mode === "wallet"
            ? "Connected wallet identity. ENS profile data appears when available."
            : hasInjectedWallet
              ? "Connect a wallet to use your address and ENS profile."
              : walletConnectAvailable
                ? "Connect with WalletConnect to use your address and ENS profile."
                : "Local identity mode is active."}
        </p>
        <p className="muted">
          Mode: <span className="pill">{transportId}</span> {transportText}
        </p>
        <div className="grid2">
          <Field label="Display name"><input className="input" value={identity.handle ?? ""} onChange={(e) => setHandle(e.target.value)} /></Field>
          <Field label="Address"><input className="input" value={identity.address} readOnly /></Field>
          <Field label={t("settings.language")}>
            <select className="input" value={lang} onChange={(e) => setLang(e.target.value as LangCode)}>
              {Object.entries(LANGS).map(([code, l]) => <option key={code} value={code}>{l.label}</option>)}
            </select>
          </Field>
        </div>
        {walletError && <div className="muted status-line status-error">{walletError}</div>}
        <div className="row-end">
          {mode === "wallet" ? (
            <Button variant="ghost" onClick={() => { void disconnectWallet(); }}>Disconnect</Button>
          ) : (
            <>
              {walletConnectAvailable && (
                <Button variant={hasInjectedWallet ? "ghost" : "primary"} onClick={connectWalletConnect} disabled={isConnecting}>
                  {isConnecting ? "Connecting..." : "WalletConnect"}
                </Button>
              )}
              {hasInjectedWallet && (
                <Button variant="primary" onClick={connectWallet} disabled={isConnecting}>
                  {isConnecting ? "Connecting..." : "Connect wallet"}
                </Button>
              )}
              {!hasInjectedWallet && !walletConnectAvailable && (
                <Button variant="ghost" onClick={reset}>Regenerate identity</Button>
              )}
            </>
          )}
        </div>
        <div className="pref-row account-messaging">
          <div>
            <div className="pref-title">Messaging</div>
            {transportId !== "xmtp" ? (
              <div className="muted">Messaging runs locally in mock mode.</div>
            ) : mode !== "wallet" ? (
              <div className="muted">Connect a wallet above to enable encrypted messaging.</div>
            ) : transportStatus === "ready" ? (
              <div className="muted status-positive">✓ Messaging enabled on this device.</div>
            ) : (
              <>
                <div className="muted">One-time signature to create your encrypted inbox. No gas, no transaction.</div>
                {transportError && <div className="muted sync-status status-error">{transportError}</div>}
              </>
            )}
          </div>
          {transportId === "xmtp" && mode === "wallet" && transportStatus !== "ready" && (
            transportNeedsRevoke ? (
              <Button
                variant="primary"
                onClick={() => { void enableMessaging({ revokeStale: true }); }}
                disabled={transportStatus === "enabling"}
                title="Revoke this inbox's old devices/sessions, then enable messaging here. Other signed-in devices will need to reconnect."
              >
                {transportStatus === "enabling" ? "Revoking…" : "Revoke old sessions & enable"}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => { void enableMessaging(); }}
                disabled={transportStatus === "enabling"}
              >
                {transportStatus === "enabling" ? "Enabling..." : "Enable messaging"}
              </Button>
            )
          )}
        </div>
      </section>

      <section className="card">
        <h2>ENS resolver</h2>
        <Field
          label="Name or address"
          hint="Type a name to check availability live, or an address to reverse-resolve."
        >
          <input
            className="input"
            value={resolverInput}
            placeholder="name.eth or 0x address"
            onChange={(e) => setResolverInput(e.target.value)}
          />
        </Field>
        <div className={`muted resolver-result ${resolverState === "success" ? "status-positive" : ""}`}>
          {resolverText}
        </div>
      </section>

      <section className="card">
        <div className="pref-row">
          <div>
            <div className="pref-title">Read receipts (default)</div>
            <div className="muted">
              The default for every chat — override it per conversation from the chat header. When on, people see when you've read their messages and you see when they've read theirs.
            </div>
          </div>
          <Toggle checked={prefs.readReceiptsDefault} onChange={setReadReceiptsDefault} label="Read receipts default" />
        </div>
        <div className="pref-row">
          <div>
            <div className="pref-title">Sync across devices</div>
            <div className="muted">{syncDescription}</div>
            {syncMessage && (
              <div className={`muted sync-status ${syncMessageKind === "success" ? "status-positive" : syncMessageKind === "error" ? "status-error" : ""}`}>
                {syncMessage}
              </div>
            )}
          </div>
          <Button
            variant={prefs.syncAcrossDevices ? "ghost" : "primary"}
            onClick={handleSyncClick}
            disabled={syncState.isEncrypting}
          >
            {syncState.isEncrypting ? "Signing..." : prefs.syncAcrossDevices ? "Turn off" : "Turn on"}
          </Button>
        </div>
      </section>

      <UpdateCard />

      <section className="card">
        <div className="row-between">
          <h2>Organizations</h2>
          <div className="gate-add">
            <Button variant="ghost" onClick={onImportOrg}>Import</Button>
            <Button variant="primary" onClick={onCreateOrg}>Create</Button>
          </div>
        </div>
        <p className="muted">Import an org config or create one. Chats stay inside the active org.</p>
        <div className="org-table">
          {orgs.map((o) => (
            <div key={o.id} className={`org-row ${o.id === activeOrgId ? "active" : ""}`}>
              <Avatar id={o.id} label={o.branding.name} size={34} />
              <div className="org-row-main">
                <div className="org-row-name">{o.branding.name} {o.id === activeOrgId && <span className="pill">active</span>}</div>
                <div className="org-row-meta">
                  ns: {o.namespace} · chain {o.chain.chainId} · entry: {gateSummary(o.entryGate)} · rooms: {o.defaultRooms.length}
                  {o.gating.powerTier && ` · ${o.gating.powerTier.label} tiers`}
                </div>
              </div>
              <div className="org-row-actions">
                {o.id !== activeOrgId && <Button variant="ghost" onClick={() => setActiveOrg(o.id)}>Switch</Button>}
                <Button variant="ghost" onClick={() => download(`${o.branding.slug}.org.json`, serializeOrg(o))}>Export</Button>
                {o.id !== "org_personal" && <Button variant="danger" onClick={() => removeOrg(o.id)}>Remove</Button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Active organization</h2>
        <div className="org-detail">
          <div><strong>{activeOrg.branding.name}</strong> <span className="muted">({shortAddr(activeOrg.id)})</span></div>
          <div className="muted">Accent {activeOrg.branding.accent} · namespace {activeOrg.namespace}</div>
          {activeOrg.gateUrl && <div className="muted">Gate: {activeOrg.gateUrl}</div>}
          <div className="muted">Roles: {activeOrg.roles.map((r) => r.label).join(", ") || "none"}</div>
        </div>
      </section>

      <section className="card">
        <h2>Blocked ({prefs.blocked.length})</h2>
        {prefs.blocked.length === 0 ? (
          <div className="muted blocked-empty">No one blocked.</div>
        ) : (
          <div className="org-table">
            {prefs.blocked.map((addr) => (
              <div key={addr} className="org-row">
                <Avatar id={addr} size={34} />
                <div className="org-row-main">
                  <div className="org-row-name">{shortAddr(addr)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="muted settings-footer">
        Direct messages use XMTP when enabled. Your profile picture comes from ENS. Preferences live on this device unless sync is on.
      </p>
    </div>
  );
}
