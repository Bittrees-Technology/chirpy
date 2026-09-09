import React, { useEffect, useMemo, useState } from "react";
import { serializeOrg } from "@app/core";
import { useChat, useIdentity, useOrgs, useSettingsPrefs } from "../state";
import { Avatar, Button, Field, Modal, Toggle, shortAddr } from "../ui";
import { download } from "./dialogs";
import { UpdateCard } from "./UpdateCard";
import { translateStatus } from "../i18n/statusMessages";
import { useI18n, LANGS, type LangCode } from "../i18n";
import { isAddress, isEnsName, resolveEns, type EnsRecord } from "../ens";


export function Settings(
  { onCreateOrg, onImportOrg }: { onCreateOrg: () => void; onImportOrg: () => void },
) {
  const {
    identity, mode, hasInjectedWallet, walletConnectAvailable, isConnecting, ensProfile, walletError,
    setHandle, reset, connectWallet, connectWalletConnect, disconnectWallet,
  } = useIdentity();
  const { orgs, recoverySnapshots, organizationStorageError, activeOrg, activeOrgId, setActiveOrg, removeOrg } = useOrgs();
  const { prefs, syncState, setReadReceiptsDefault, enableSyncAcrossDevices, disableSyncAcrossDevices, revokeAllSyncDevices } = useSettingsPrefs();
  const { transportId, transportStatus, transportError, transportNeedsRevoke, enableMessaging } = useChat();
  const { lang, setLang, t } = useI18n();
  const gateSummary = (rules: unknown[]) => rules.length === 0 ? t("settings.open") : rules.length === 1 ? t("settings.oneRule") : t("settings.rules", undefined, { count: rules.length });
  const [profileEns, setProfileEns] = useState<EnsRecord | null>(null);
  const [resolverInput, setResolverInput] = useState("");
  const [resolverState, setResolverState] = useState<"idle" | "loading" | "success" | "neutral" | "error">("idle");
  const [resolverText, setResolverText] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const [syncMessageKind, setSyncMessageKind] = useState<"success" | "error" | "neutral">("neutral");
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);

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
        setResolverText(t("settings.resolverInvalid"));
        return;
      }

      setResolverState("loading");
      setResolverText(t("settings.resolverLoading"));
      resolveEns(query)
        .then((record) => {
          if (cancelled) return;
          if (isEnsName(query)) {
            if (record.address) {
              setResolverState("success");
              setResolverText(t("settings.resolved", undefined, { name: record.displayName ?? record.name ?? query, address: record.address }));
            } else {
              setResolverState("neutral");
              setResolverText(t("settings.notResolved", undefined, { name: query }));
            }
            return;
          }

          if (record.name) {
            setResolverState("success");
            setResolverText(t("settings.reverseResolved", undefined, { address: shortAddr(query), name: record.name }));
          } else {
            setResolverState("neutral");
            setResolverText(t("settings.resolverNoName"));
          }
        })
        .catch(() => {
          if (cancelled) return;
          setResolverState("error");
          setResolverText(t("settings.resolverError"));
        });
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [resolverInput, t]);

  const activeProfile = mode === "wallet" ? ensProfile ?? profileEns : profileEns;
  const ensName = activeProfile?.name ?? (isEnsName(identity.handle ?? "") ? identity.handle : undefined);
  const profileName = activeProfile?.displayName ?? ensName ?? identity.handle ?? shortAddr(identity.address);
  const profileAvatar = activeProfile?.address && activeProfile.avatar ? activeProfile.avatar : undefined;
  const ensManagerTarget = ensName ?? identity.address;
  const syncDescription = prefs.syncAcrossDevices
    ? syncState.hasSessionKey
      ? t("settings.syncActive")
      : t("settings.syncPaused")
    : t("settings.syncOff");
  const transportText = transportId === "mock"
    ? t("settings.mockMode")
    : t("settings.xmtpMode");
  const handleSyncClick = async () => {
    setSyncMessage("");
    setSyncMessageKind("neutral");
    if (prefs.syncAcrossDevices && syncState.hasSessionKey) {
      const result = await disableSyncAcrossDevices();
      setSyncMessage(result.message);
      setSyncMessageKind(result.ok ? "success" : "error");
      return;
    }
    const result = await enableSyncAcrossDevices();
    setSyncMessage(result.message);
    setSyncMessageKind(result.ok ? "success" : "error");
  };

  return (
    <div className="settings">
      <h1>{t("nav.settings")}</h1>
      {organizationStorageError && <p role="alert">{t("settings.orgStorageError")}</p>}
      {recoverySnapshots.length > 0 && <section className="card" aria-label={t("settings.orgRecovery")}>
        <h2>{t("settings.orgRecovery")}</h2>
        <p role="status">{t("settings.orgRecoveryHelp")}</p>
        <Button variant="ghost" onClick={() => download("chirpy-organization-recovery.json", JSON.stringify({ snapshots: recoverySnapshots }, null, 2))}>
          {t("settings.orgRecoveryDownload")}
        </Button>
      </section>}

      <section className="card">
        <div className="profile-row">
          <div className="profile-main">
            <Avatar id={identity.address} label={profileName} src={profileAvatar} size={64} />
            <div>
              <h2>{t("settings.profile")}</h2>
              <div className="profile-name">{profileName}</div>
              <div className="muted">{shortAddr(identity.address)}</div>
            </div>
          </div>
          <Button
            variant="ghost"
            onClick={() => window.open(`https://app.ens.domains/${encodeURIComponent(ensManagerTarget)}`, "_blank", "noopener,noreferrer")}
          >
            {t("settings.changePicture")}
          </Button>
        </div>
        {profileAvatar && ensName ? (
          <p className="muted status-line status-positive">{t("settings.pictureSet", undefined, { name: ensName })}</p>
        ) : (
          <p className="muted status-line">{t("settings.pictureHelp")}</p>
        )}
      </section>

      <section className="card">
        <h2>{t("settings.account")}</h2>
        <p className="muted">
          {mode === "wallet"
            ? t("settings.walletIdentity")
            : hasInjectedWallet
              ? t("settings.connectIdentity")
              : walletConnectAvailable
                ? t("settings.walletConnectIdentity")
                : t("settings.localIdentity")}
        </p>
        <p className="muted">
          {t("settings.mode")} <span className="pill">{transportId}</span> {transportText}
        </p>
        <div className="grid2">
          <Field label={t("settings.displayName")}><input className="input" value={identity.handle ?? ""} onChange={(e) => setHandle(e.target.value)} /></Field>
          <Field label={t("settings.address")}><input className="input" value={identity.address} readOnly /></Field>
          <Field label={t("settings.language")}>
            <select className="input" value={lang} onChange={(e) => setLang(e.target.value as LangCode)}>
              {Object.entries(LANGS).map(([code, l]) => <option key={code} value={code}>{l.label}</option>)}
            </select>
          </Field>
        </div>
        {walletError && <div className="muted status-line status-error">{translateStatus(t, walletError)}</div>}
        <div className="row-end">
          {mode === "wallet" ? (
            <Button variant="ghost" onClick={() => { void disconnectWallet(); }}>{t("settings.disconnect")}</Button>
          ) : (
            <>
              {walletConnectAvailable && (
                <Button variant={hasInjectedWallet ? "ghost" : "primary"} onClick={connectWalletConnect} disabled={isConnecting}>
                  {isConnecting ? t("settings.connecting") : "WalletConnect"}
                </Button>
              )}
              {hasInjectedWallet && (
                <Button variant="primary" onClick={connectWallet} disabled={isConnecting}>
                  {isConnecting ? t("settings.connecting") : t("settings.connectWallet")}
                </Button>
              )}
              {!hasInjectedWallet && !walletConnectAvailable && (
                <Button variant="ghost" onClick={reset}>{t("settings.regenerate")}</Button>
              )}
            </>
          )}
        </div>
        <div className="pref-row account-messaging">
          <div>
            <div className="pref-title">{t("settings.messaging")}</div>
            {transportId !== "xmtp" ? (
              <div className="muted">{t("settings.mockMessaging")}</div>
            ) : mode !== "wallet" ? (
              <div className="muted">{t("settings.connectMessaging")}</div>
            ) : transportStatus === "ready" ? (
              <div className="muted status-positive">{t("settings.messagingReady")}</div>
            ) : (
              <>
                <div className="muted">{t("settings.messagingSignature")}</div>
                {transportError && <div className="muted sync-status status-error">{translateStatus(t, transportError)}</div>}
              </>
            )}
          </div>
          {transportId === "xmtp" && mode === "wallet" && transportStatus !== "ready" && (
            transportNeedsRevoke ? (
              <Button
                variant="primary"
                onClick={() => setShowRevokeConfirm(true)}
                disabled={transportStatus === "enabling"}
              >
                {transportStatus === "enabling" ? t("settings.revoking") : t("settings.revokeEnable")}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => { void enableMessaging(); }}
                disabled={transportStatus === "enabling"}
              >
                {transportStatus === "enabling" ? t("settings.enabling") : t("settings.enableMessaging")}
              </Button>
            )
          )}
        </div>
      </section>

      <section className="card">
        <h2>{t("settings.resolver")}</h2>
        <Field
          label={t("settings.nameOrAddress")}
          hint={t("settings.resolverHint")}
        >
          <input
            className="input"
            value={resolverInput}
            placeholder={t("settings.resolverPlaceholder")}
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
            <div className="pref-title">{t("settings.receiptTitle")}</div>
            <div className="muted">
              {t("settings.receiptHelp")}
            </div>
          </div>
          <Toggle checked={prefs.readReceiptsDefault} onChange={setReadReceiptsDefault} label={t("settings.receiptLabel")} />
        </div>
        <div className="pref-row">
          <div>
            <div className="pref-title">{t("settings.syncTitle")}</div>
            <div className="muted">{syncDescription}</div>
            {syncState.error && <div role="alert">{translateStatus(t, syncState.error)}</div>}
            {syncMessage && (
              <div role="status" className={`muted sync-status ${syncMessageKind === "success" ? "status-positive" : syncMessageKind === "error" ? "status-error" : ""}`}>
                {translateStatus(t, syncMessage)}
              </div>
            )}
          </div>
          <Button
            variant={prefs.syncAcrossDevices ? "ghost" : "primary"}
            onClick={handleSyncClick}
            disabled={syncState.isEncrypting}
          >
            {syncState.isEncrypting ? t("settings.signing") : prefs.syncAcrossDevices && syncState.hasSessionKey ? t("settings.turnOff") : prefs.syncAcrossDevices ? t("settings.reenable") : t("settings.turnOn")}
          </Button>
        </div>
      </section>

      <UpdateCard />

      <section className="card">
        <div className="row-between">
          <h2>{t("settings.organizations")}</h2>
          <div className="gate-add">
            <Button variant="ghost" onClick={onImportOrg}>{t("settings.import")}</Button>
            <Button variant="primary" onClick={onCreateOrg}>{t("settings.create")}</Button>
          </div>
        </div>
        <p className="muted">{t("settings.orgHelp")}</p>
        <div className="org-table">
          {orgs.map((o) => (
            <div key={o.id} className={`org-row ${o.id === activeOrgId ? t("settings.active") : ""}`}>
              <Avatar id={o.id} label={o.branding.name} size={34} />
              <div className="org-row-main">
                <div className="org-row-name">{o.branding.name} {o.id === activeOrgId && <span className="pill">{t("settings.active")}</span>}</div>
                <div className="org-row-meta">
                  {t("settings.orgMeta", undefined, { namespace: o.namespace, chain: o.chain.chainId, entry: gateSummary(o.entryGate), rooms: o.defaultRooms.length })}
                  {o.gating.powerTier && t("settings.tiers", undefined, { label: o.gating.powerTier.label })}
                </div>
              </div>
              <div className="org-row-actions">
                {o.id !== activeOrgId && <Button variant="ghost" onClick={() => setActiveOrg(o.id)}>{t("settings.switch")}</Button>}
                <Button variant="ghost" onClick={() => download(`${o.branding.slug}.org.json`, serializeOrg(o))}>{t("settings.export")}</Button>
                {o.id !== "org_personal" && <Button variant="danger" onClick={() => removeOrg(o.id)}>{t("settings.remove")}</Button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>{t("settings.activeOrg")}</h2>
        <div className="org-detail">
          <div><strong>{activeOrg.branding.name}</strong> <span className="muted">({shortAddr(activeOrg.id)})</span></div>
          <div className="muted">{t("settings.orgDetails", undefined, { accent: activeOrg.branding.accent ?? "", namespace: activeOrg.namespace })}</div>
          {activeOrg.gateUrl && <div className="muted">{t("settings.gate", undefined, { url: activeOrg.gateUrl })}</div>}
          <div className="muted">{t("settings.roles", undefined, { roles: activeOrg.roles.map((r) => r.label).join(", ") || t("settings.none") })}</div>
        </div>
      </section>

      <section className="card">
        <h2>{t("settings.syncSecurity")}</h2>
        <p>{t("settings.revokeHelp")}</p>
        <Button variant="danger" disabled={syncState.isEncrypting || mode !== "wallet"} onClick={async () => {
          const result = await revokeAllSyncDevices();
          setSyncMessage(result.message);
          setSyncMessageKind(result.ok ? "success" : "error");
        }}>{t("settings.revokeAll")}</Button>
      </section>

      <section className="card">
        <h2>{t("list.blocked", "Blocked")}</h2>
        <p>{t("settings.blockedHelp", "Manage blocked conversations in Chats → Blocked. Blocking hides this direct conversation and stops your outgoing messages and receipts. It does not remove messages from shared rooms.")}</p>
      </section>

      <p className="muted settings-footer">
        {t("settings.footer")}
      </p>

      {showRevokeConfirm && (
        <Modal title={t("settings.revokeTitle")} onClose={() => setShowRevokeConfirm(false)}>
          <p className="muted">
            {t("settings.revokeLimit")}
          </p>
          <p className="muted">
            {t("settings.revokeEffect")}
          </p>
          <p className="muted">{t("settings.revokeSignature")}</p>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setShowRevokeConfirm(false)}>{t("settings.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => { setShowRevokeConfirm(false); void enableMessaging({ revokeStale: true }); }}
            >
              {t("settings.revokeHere")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
