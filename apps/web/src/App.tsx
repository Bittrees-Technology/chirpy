import React, { useState, useEffect } from "react";
import { useChat, useIdentity, useOrgs } from "./state";
import { useI18n } from "./i18n";
import { autoUpdateOnLaunch } from "./update";
import { Avatar, shortAddr } from "./ui";
import { APP_NAME } from "./app.config";
import { ConversationColumn } from "./views/List";
import { Thread } from "./views/Thread";
import { Settings } from "./views/Settings";
import { NewDmDialog, NewRoomDialog, CreateOrgDialog, ImportOrgDialog } from "./views/dialogs";

type View = "chats" | "rooms" | "settings";
type Dialog = null | "newDm" | "newRoom" | "createOrg" | "importOrg";

function OrgRail({ onCreateOrg }: { onCreateOrg: () => void }) {
  const { orgs, activeOrgId, setActiveOrg } = useOrgs();
  return (
    <div className="org-rail">
      {orgs.map((o) => (
        <button
          key={o.id}
          className={`org-pip ${o.id === activeOrgId ? "active" : ""}`}
          title={o.branding.name}
          onClick={() => setActiveOrg(o.id)}
          style={{ ["--pip" as any]: o.branding.accent }}
        >
          <Avatar id={o.id} label={o.branding.name} size={42} />
        </button>
      ))}
      <button className="org-pip add" title="Create organization" onClick={onCreateOrg}>＋</button>
    </div>
  );
}

function Sidebar(
  { view, setView, onCreateOrg }: { view: View; setView: (v: View) => void; onCreateOrg: () => void },
) {
  const { identity } = useIdentity();
  const { activeOrg } = useOrgs();
  const { t } = useI18n();
  const nav: { id: View; label: string; icon: string }[] = [
    { id: "chats", label: t("nav.chats"), icon: "💬" },
    { id: "rooms", label: t("nav.rooms"), icon: "🏛️" },
    { id: "settings", label: t("nav.settings"), icon: "⚙️" },
  ];
  return (
    <aside className="sidebar">
      <OrgRail onCreateOrg={onCreateOrg} />
      <div className="sidebar-main">
        <div className="brand">
          <div className="brand-name">{APP_NAME}</div>
          <div className="brand-org">{activeOrg.branding.name}</div>
        </div>
        <nav className="nav">
          {nav.map((n) => (
            <button key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)}>
              <span className="nav-icon">{n.icon}</span> {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <Avatar id={identity.address} label={identity.handle} size={30} />
          <div className="foot-meta">
            <div className="foot-name">{identity.handle}</div>
            <div className="foot-addr">{shortAddr(identity.address)}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function App() {
  const { transportId, transportStatus, transportError, enableMessaging } = useChat();
  const { mode, hasInjectedWallet, connectWallet, isConnecting } = useIdentity();
  const [view, setView] = useState<View>("chats");
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const xmtpNeedsEnable = transportId === "xmtp" && transportStatus !== "ready";

  // Silent auto-update check on launch (desktop only; no-op on web/mobile).
  useEffect(() => { void autoUpdateOnLaunch(); }, []);

  return (
    <div className="app">
      <Sidebar view={view} setView={setView} onCreateOrg={() => setDialog("createOrg")} />
      <main className="main">
        {xmtpNeedsEnable && (
          <div className="error-banner" style={{ margin: 12 }}>
            {mode === "wallet"
              ? "XMTP messaging is off for this wallet. Sign once to enable DMs on this browser."
              : hasInjectedWallet
                ? "Connect a wallet to enable XMTP DMs."
                : "Open Chirpy in a browser with an injected wallet to enable XMTP DMs."}
            <button
              className="btn btn-primary btn-sm"
              style={{ marginLeft: 12 }}
              disabled={transportStatus === "enabling" || isConnecting || (!hasInjectedWallet && mode !== "wallet")}
              onClick={() => { void (mode === "wallet" ? enableMessaging() : connectWallet()); }}
            >
              {mode === "wallet" ? (transportStatus === "enabling" ? "Enabling..." : "Enable messaging") : "Connect wallet"}
            </button>
            {transportError && <span style={{ marginLeft: 12 }}>{transportError}</span>}
          </div>
        )}
        {view === "chats" && (
          <div className="split">
            <ConversationColumn kind="dm" title="Chats" newLabel="+ New" onNew={() => setDialog("newDm")} />
            <Thread />
          </div>
        )}
        {view === "rooms" && (
          <div className="split">
            <ConversationColumn kind="room" title="Rooms" newLabel="+ Room" onNew={() => {
              if (transportId !== "xmtp") setDialog("newRoom");
            }} />
            <Thread />
          </div>
        )}
        {view === "settings" && (
          <Settings onCreateOrg={() => setDialog("createOrg")} onImportOrg={() => setDialog("importOrg")} />
        )}
      </main>

      {dialog === "newDm" && <NewDmDialog onClose={close} />}
      {dialog === "newRoom" && transportId !== "xmtp" && <NewRoomDialog onClose={close} />}
      {dialog === "createOrg" && <CreateOrgDialog onClose={close} />}
      {dialog === "importOrg" && <ImportOrgDialog onClose={close} />}
    </div>
  );
}
