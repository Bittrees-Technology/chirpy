import React, { useState } from "react";
import {
  createOrg, parseOrg, serializeOrg,
  type GatingConfig, type Policy, type RoomRule,
} from "@app/core";
import { useChat, useOrgs } from "../state";
import { Button, Field, Modal } from "../ui";
import { PRESETS } from "../presets";

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---------------- New DM ----------------
export function NewDmDialog({ onClose }: { onClose: () => void }) {
  const { startDm } = useChat();
  const [address, setAddress] = useState("");
  const [handle, setHandle] = useState("");
  const valid = /^0x[a-fA-F0-9]{40}$/.test(address.trim()) || /\.eth$/.test(address.trim());
  return (
    <Modal title="New direct message" onClose={onClose}>
      <Field label="Address or ENS name" hint="0x… or name.eth">
        <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x… or vitalik.eth" autoFocus />
      </Field>
      <Field label="Display name (optional)">
        <input className="input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="alice" />
      </Field>
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid} onClick={async () => { await startDm(address.trim(), handle.trim() || undefined); onClose(); }}>Start chat</Button>
      </div>
    </Modal>
  );
}

// ---------------- Gate rule editor ----------------
function defaultRule(kind: RoomRule["kind"]): RoomRule {
  switch (kind) {
    case "token": return { kind: "token", standard: "erc20", token: "", min: "1" };
    case "safe": return { kind: "safe", safe: "" };
    case "ens": return { kind: "ens" };
    case "role": return { kind: "role", role: "" };
    case "power": return { kind: "power", tier: 1 };
  }
}

export function GateRuleEditor(
  { rules, onChange, gating }: { rules: RoomRule[]; onChange: (r: RoomRule[]) => void; gating: GatingConfig },
) {
  const update = (i: number, patch: Partial<RoomRule>) =>
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } as RoomRule : r)));
  const remove = (i: number) => onChange(rules.filter((_, idx) => idx !== i));
  const add = (kind: RoomRule["kind"]) => onChange([...rules, defaultRule(kind)]);

  return (
    <div className="gate-editor">
      <div className="gate-add">
        <span className="field-label">Add rule:</span>
        <button className="chip" onClick={() => add("token")}>Token</button>
        {gating.enableSafeRules && <button className="chip" onClick={() => add("safe")}>Safe</button>}
        {gating.enableEnsRules && <button className="chip" onClick={() => add("ens")}>ENS</button>}
        <button className="chip" onClick={() => add("role")}>Role</button>
        {gating.powerTier && <button className="chip" onClick={() => add("power")}>{gating.powerTier.label}</button>}
      </div>
      {rules.length === 0 && <div className="field-hint">No rules = open to everyone.</div>}
      {rules.map((r, i) => (
        <div key={i} className="gate-row">
          {r.kind === "token" && (
            <>
              <select className="input input-sm" value={r.standard} onChange={(e) => update(i, { standard: e.target.value as any })}>
                <option value="erc20">ERC-20</option>
                <option value="erc721">ERC-721</option>
                <option value="erc1155">ERC-1155</option>
              </select>
              <input className="input input-sm" placeholder="token 0x…" value={r.token} onChange={(e) => update(i, { token: e.target.value })} />
              <input className="input input-sm input-xs" placeholder="min" value={r.min} onChange={(e) => update(i, { min: e.target.value })} />
              {r.standard === "erc1155" && (
                <input className="input input-sm input-xs" placeholder="id (opt)" value={(r as any).tokenId ?? ""} onChange={(e) => update(i, { tokenId: e.target.value } as any)} />
              )}
            </>
          )}
          {r.kind === "safe" && <input className="input input-sm" placeholder="Safe 0x…" value={r.safe} onChange={(e) => update(i, { safe: e.target.value })} />}
          {r.kind === "ens" && <input className="input input-sm" placeholder="name.eth (blank = any ENS)" value={r.name ?? ""} onChange={(e) => update(i, { name: e.target.value })} />}
          {r.kind === "role" && <input className="input input-sm" placeholder="role label" value={r.role} onChange={(e) => update(i, { role: e.target.value })} />}
          {r.kind === "power" && <input className="input input-sm input-xs" type="number" value={r.tier} onChange={(e) => update(i, { tier: Number(e.target.value) || 0 })} />}
          <button className="icon-btn" onClick={() => remove(i)} aria-label="Remove rule">✕</button>
        </div>
      ))}
    </div>
  );
}

// ---------------- Policy editor (the "action gate") ----------------
export function PolicyEditor(
  { value, onChange }: { value: Partial<Policy>; onChange: (p: Partial<Policy>) => void },
) {
  const maxMb = value.maxUploadBytes ? Math.round(value.maxUploadBytes / (1024 * 1024)) : 0;
  return (
    <div className="checks">
      <label className="check"><input type="checkbox" checked={value.mode === "read-only"} onChange={(e) => onChange({ ...value, mode: e.target.checked ? "read-only" : "active" })} /> Read-only (freeze posting)</label>
      <label className="check"><input type="checkbox" checked={value.attachments === "block"} onChange={(e) => onChange({ ...value, attachments: e.target.checked ? "block" : "allow" })} /> Block attachments</label>
      <Field label="Max upload size (MB · 0 = no limit)">
        <input className="input input-sm input-xs" type="number" min={0} value={maxMb} onChange={(e) => onChange({ ...value, maxUploadBytes: (Number(e.target.value) || 0) * 1024 * 1024 })} />
      </Field>
    </div>
  );
}

// ---------------- New Room ----------------
export function NewRoomDialog({ onClose }: { onClose: () => void }) {
  const { createRoom } = useChat();
  const { activeOrg } = useOrgs();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [combine, setCombine] = useState<"any" | "all">("any");
  const [rules, setRules] = useState<RoomRule[]>([]);
  const [policy, setPolicy] = useState<Partial<Policy>>({});
  return (
    <Modal title="New room" onClose={onClose} wide>
      <Field label="Room name"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="general" autoFocus /></Field>
      <Field label="Description (optional)"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Access" hint="Who may join. Multiple rules combine by the mode below.">
        <select className="input input-sm" value={combine} onChange={(e) => setCombine(e.target.value as any)}>
          <option value="any">Match ANY rule</option>
          <option value="all">Match ALL rules</option>
        </select>
      </Field>
      <GateRuleEditor rules={rules} onChange={setRules} gating={activeOrg.gating} />
      <div className="section-title">Policy <span className="field-hint">(what may happen — overrides the org default)</span></div>
      <PolicyEditor value={policy} onChange={setPolicy} />
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!title.trim()} onClick={async () => { await createRoom({ title: title.trim(), description: description.trim() || undefined, gate: { combine, rules }, policy }); onClose(); }}>Create room</Button>
      </div>
    </Modal>
  );
}

// ---------------- Create Org ----------------
export function CreateOrgDialog({ onClose }: { onClose: () => void }) {
  const { addOrg } = useOrgs();
  const [name, setName] = useState("");
  const [accent, setAccent] = useState("#6366f1");
  const [chainId, setChainId] = useState(1);
  const [gateUrl, setGateUrl] = useState("");
  const [enableSafe, setEnableSafe] = useState(true);
  const [enableEns, setEnableEns] = useState(true);
  const [usePower, setUsePower] = useState(false);
  const [powerLabel, setPowerLabel] = useState("Power");
  const [powerTiers, setPowerTiers] = useState("1,10,100");
  const [entryGate, setEntryGate] = useState<RoomRule[]>([]);
  const [policy, setPolicy] = useState<Partial<Policy>>({});
  const [themeCss, setThemeCss] = useState("");

  const gating: GatingConfig = {
    enableTokenRules: true,
    enableSafeRules: enableSafe,
    enableEnsRules: enableEns,
    roleCascade: {},
    powerTier: usePower
      ? { label: powerLabel || "Power", resolver: "erc20-votes", tiers: powerTiers.split(",").map((t) => Number(t.trim()) || 0).filter(Boolean) }
      : null,
  };

  const create = () => {
    const org = createOrg({ name, accent, chainId, gateUrl: gateUrl.trim() || undefined, entryGate, gating, policy, themeCss: themeCss.trim() || undefined });
    addOrg(org);
    onClose();
  };

  return (
    <Modal title="Create organization" onClose={onClose} wide>
      <div className="grid2">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme DAO" autoFocus /></Field>
        <Field label="Accent color"><input className="input input-color" type="color" value={accent} onChange={(e) => setAccent(e.target.value)} /></Field>
        <Field label="Chain ID"><input className="input" type="number" value={chainId} onChange={(e) => setChainId(Number(e.target.value) || 1)} /></Field>
        <Field label="Gate URL (optional)" hint="serverless gate endpoint"><input className="input" value={gateUrl} onChange={(e) => setGateUrl(e.target.value)} placeholder="https://acme.org/api/gate" /></Field>
      </div>

      <div className="section-title">Capabilities</div>
      <div className="checks">
        <label className="check"><input type="checkbox" checked disabled /> Token rules (ERC-20/721/1155)</label>
        <label className="check"><input type="checkbox" checked={enableSafe} onChange={(e) => setEnableSafe(e.target.checked)} /> Gnosis Safe rules</label>
        <label className="check"><input type="checkbox" checked={enableEns} onChange={(e) => setEnableEns(e.target.checked)} /> ENS rules</label>
        <label className="check"><input type="checkbox" checked={usePower} onChange={(e) => setUsePower(e.target.checked)} /> Voting-power tiers</label>
      </div>
      {usePower && (
        <div className="grid2">
          <Field label="Power label"><input className="input" value={powerLabel} onChange={(e) => setPowerLabel(e.target.value)} /></Field>
          <Field label="Tiers (comma-sep)"><input className="input" value={powerTiers} onChange={(e) => setPowerTiers(e.target.value)} /></Field>
        </div>
      )}

      <div className="section-title">Membership entry gate <span className="field-hint">(optional — blank = open org)</span></div>
      <GateRuleEditor rules={entryGate} onChange={setEntryGate} gating={gating} />

      <div className="section-title">Default room policy <span className="field-hint">(rooms can override)</span></div>
      <PolicyEditor value={policy} onChange={setPolicy} />

      <div className="section-title">Custom theme CSS <span className="field-hint">(optional — re-skins the app for this org)</span></div>
      <textarea className="input textarea" rows={4} value={themeCss} onChange={(e) => setThemeCss(e.target.value)} placeholder={":root { --accent: #e11d48; --bg: #0a0a0a; }"} />

      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!name.trim()} onClick={create}>Create organization</Button>
      </div>
    </Modal>
  );
}

// ---------------- Import Org ----------------
export function ImportOrgDialog({ onClose }: { onClose: () => void }) {
  const { addOrg } = useOrgs();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const doImport = () => {
    try {
      const org = parseOrg(text);
      addOrg(org);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Import organization" onClose={onClose} wide>
      <Field label="Load a preset" hint="Example configs that map the two Bittrees apps onto one OrgConfig.">
        <div className="gate-add">
          {PRESETS.map((p) => (
            <button key={p.label} className="chip" onClick={() => { setText(serializeOrg(p.org)); setError(null); }}>{p.label}</button>
          ))}
        </div>
      </Field>
      <Field label="Org config JSON" hint="Paste an exported organization, or pick a preset above.">
        <textarea className="input textarea" rows={12} value={text} onChange={(e) => { setText(e.target.value); setError(null); }} placeholder='{ "version": 1, "branding": { "name": "..." }, ... }' />
      </Field>
      {error && <div className="error-banner">{error}</div>}
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!text.trim()} onClick={doImport}>Import</Button>
      </div>
    </Modal>
  );
}

export { download };
