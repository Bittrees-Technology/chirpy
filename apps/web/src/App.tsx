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

type View = "chats" | "settings";
type Dialog = null | "newDm" | "newRoom" | "createOrg" | "importOrg";
type MobilePane = "list" | "thread";

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

function MobileNav({ view, setView }: { view: View; setView: (v: View) => void }) {
  const { t } = useI18n();
  const nav: { id: View; label: string; icon: string }[] = [
    { id: "chats", label: t("nav.chats"), icon: "💬" },
    { id: "settings", label: t("nav.settings"), icon: "⚙️" },
  ];
  return (
    <nav className="mobile-nav" aria-label="Primary">
      {nav.map((n) => (
        <button key={n.id} className={`mobile-nav-item ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)}>
          <span className="nav-icon">{n.icon}</span>
          <span>{n.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function App() {
  const { transportId, transportStatus } = useChat();
  const [view, setView] = useState<View>("chats");
  const [mobilePane, setMobilePane] = useState<MobilePane>("list");
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const needsConnect = transportId === "xmtp" && transportStatus !== "ready";
  const openView = (next: View) => {
    setView(next);
    if (next === "chats") setMobilePane("list");
  };

  // Silent auto-update check on launch (desktop only; no-op on web/mobile).
  useEffect(() => { void autoUpdateOnLaunch(); }, []);

  return (
    <div className="app">
      <Sidebar view={view} setView={openView} onCreateOrg={() => setDialog("createOrg")} />
      <main className="main">
        {view === "chats" && (
          <div className={`split mobile-${mobilePane}`}>
            <ConversationColumn
              title="Chats"
              needsConnect={needsConnect}
              onNewDm={() => setDialog("newDm")}
              onNewRoom={() => setDialog("newRoom")}
              onOpenSettings={() => openView("settings")}
              onOpenConversation={() => setMobilePane("thread")}
            />
            <Thread showBack onBack={() => setMobilePane("list")} />
          </div>
        )}
        {view === "settings" && (
          <Settings onCreateOrg={() => setDialog("createOrg")} onImportOrg={() => setDialog("importOrg")} />
        )}
      </main>
      <MobileNav view={view} setView={openView} />

      {dialog === "newDm" && <NewDmDialog onClose={close} onCreated={() => setMobilePane("thread")} />}
      {dialog === "newRoom" && <NewRoomDialog onClose={close} onCreated={() => setMobilePane("thread")} />}
      {dialog === "createOrg" && <CreateOrgDialog onClose={close} />}
      {dialog === "importOrg" && <ImportOrgDialog onClose={close} />}
    </div>
  );
}
