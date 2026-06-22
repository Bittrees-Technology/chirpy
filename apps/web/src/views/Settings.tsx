import React from "react";
import { serializeOrg, type RoomRule } from "@app/core";
import { useChat, useIdentity, useOrgs } from "../state";
import { Avatar, Button, Field, shortAddr } from "../ui";
import { download } from "./dialogs";
import { UpdateCard } from "./UpdateCard";

function gateSummary(rules: RoomRule[]): string {
  if (!rules.length) return "open";
  return `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
}

export function Settings(
  { onCreateOrg, onImportOrg }: { onCreateOrg: () => void; onImportOrg: () => void },
) {
  const { identity, setHandle, reset } = useIdentity();
  const { orgs, activeOrg, activeOrgId, setActiveOrg, removeOrg } = useOrgs();
  const { transportId } = useChat();

  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="card">
        <h2>Identity</h2>
        <p className="muted">In this preview build your identity is a local wallet stub. Connecting a real wallet (XMTP/Push) is the next phase.</p>
        <div className="grid2">
          <Field label="Display name"><input className="input" value={identity.handle ?? ""} onChange={(e) => setHandle(e.target.value)} /></Field>
          <Field label="Address"><input className="input" value={identity.address} readOnly /></Field>
        </div>
        <div className="row-end"><Button variant="ghost" onClick={reset}>Regenerate identity</Button></div>
      </section>

      <section className="card">
        <h2>Transport</h2>
        <p className="muted">
          Mode: <span className="pill">{transportId}</span>{" "}
          {transportId === "mock"
            ? "— fully offline. DMs persist per wallet (across all orgs + personal); rooms persist per org. No wallet, no network."
            : "— live XMTP DMs + Push gated rooms."}
        </p>
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
        <p className="muted">The app ships with no organization baked in. Import an existing org's config or create your own; chat lives inside each one.</p>
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
    </div>
  );
}
