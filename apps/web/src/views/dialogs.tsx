import React, { useState } from "react";
import {
  createOrg, parseOrg, serializeOrg,
  type GatingConfig, type Policy, type RoomRule,
} from "@app/core";
import { useChat, useOrgs } from "../state";
import { Button, Field, Modal } from "../ui";
import { useI18n } from "../i18n";
import { translateStatus } from "../i18n/statusMessages";
import { PRESETS } from "../presets";
import { isAddress, isEnsName, resolveEns } from "../ens";

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---------------- New DM ----------------
export function NewDmDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const { t } = useI18n();
  const { startDm } = useChat();
  const [address, setAddress] = useState("");
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = address.trim();
  const valid = isAddress(input) || isEnsName(input);
  const start = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The transport only speaks 0x addresses, so resolve ENS names here first.
      let target = input;
      let displayName = handle.trim() || undefined;
      if (!isAddress(input)) {
        const record = await resolveEns(input);
        if (!record.address) {
          setError(t("dialog.unresolved", undefined, { name: input }));
          return;
        }
        target = record.address;
        if (!displayName) displayName = record.displayName ?? record.name ?? input;
      }
      await startDm(target, displayName);
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("dialog.dmFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("dialog.dmTitle")} onClose={onClose}>
      <Field label={t("dialog.address")} hint={t("dialog.addressHint")}>
        <input
          className="input"
          value={address}
          onChange={(e) => { setAddress(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void start(); }}
          placeholder={t("dialog.addressPlaceholder")}
          autoFocus
        />
      </Field>
      <Field label={t("dialog.displayName")}>
        <input className="input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="alice" />
      </Field>
      {error && <div role="alert" className="error-banner">{translateStatus(t, error)}</div>}
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>{t("dialog.cancel")}</Button>
        <Button variant="primary" disabled={!valid || busy} onClick={() => { void start(); }}>
          {busy ? t("dialog.resolving") : t("dialog.startChat")}
        </Button>
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
  { rules, onChange, gating, production = false }: { rules: RoomRule[]; onChange: (r: RoomRule[]) => void; gating: GatingConfig; production?: boolean },
) {
  const { t } = useI18n();
  const update = (i: number, patch: Partial<RoomRule>) =>
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } as RoomRule : r)));
  const remove = (i: number) => onChange(rules.filter((_, idx) => idx !== i));
  const add = (kind: RoomRule["kind"]) => onChange([...rules, defaultRule(kind)]);

  return (
    <div className="gate-editor">
      <div className="gate-add">
        <span className="field-label">{t("dialog.addRule")}</span>
        <button data-insights="token" className="chip" onClick={() => add("token")}>Token</button>
        {gating.enableSafeRules && <button className="chip" onClick={() => add("safe")}>{production ? t("dialog.safeOwners") : "Safe"}</button>}
        {gating.enableEnsRules && <button data-insights="ens" className="chip" onClick={() => add("ens")}>ENS</button>}
        {!production && <button className="chip" onClick={() => add("role")}>{t("dialog.role")}</button>}
        {!production && gating.powerTier && <button className="chip" onClick={() => add("power")}>{gating.powerTier.label}</button>}
      </div>
      {production && <p className="field-hint">{t("dialog.supported")}</p>}
      {rules.length === 0 && <div className="field-hint">{t("dialog.openRules")}</div>}
      {rules.map((r, i) => (
        <div key={i} className="gate-row" role="group" aria-label={t("dialog.ruleNumber", undefined, { number: i + 1 })}>
          {r.kind === "token" && (
            <>
              <select aria-label={t("dialog.tokenStandard")} className="input input-sm" value={r.standard} onChange={(e) => update(i, { standard: e.target.value as any })}>
                <option value="erc20">ERC-20</option>
                <option value="erc721">ERC-721</option>
                <option value="erc1155">ERC-1155</option>
              </select>
              <input className="input input-sm" placeholder={t("dialog.tokenPlaceholder")} aria-label={t("dialog.tokenAddress")} value={r.token} onChange={(e) => update(i, { token: e.target.value })} />
              <input className="input input-sm input-xs" placeholder={t("dialog.minimumPlaceholder")} aria-label={t("dialog.minimum")} value={r.min} onChange={(e) => update(i, { min: e.target.value })} />
              {r.standard === "erc1155" && (
                <input className="input input-sm input-xs" placeholder={production ? t("dialog.tokenRequired") : t("dialog.tokenOptional")} aria-label={t("dialog.tokenId")} value={(r as any).tokenId ?? ""} onChange={(e) => update(i, { tokenId: e.target.value } as any)} />
              )}
            </>
          )}
          {r.kind === "safe" && <input className="input input-sm" placeholder={t("dialog.safePlaceholder")} aria-label={t("dialog.safeAddress")} value={r.safe} onChange={(e) => update(i, { safe: e.target.value })} />}
          {r.kind === "ens" && <input className="input input-sm" placeholder={t("dialog.ensPlaceholder")} aria-label={t("dialog.ensName")} value={r.name ?? ""} onChange={(e) => update(i, { name: e.target.value.trim() || undefined })} />}
          {r.kind === "role" && <input className="input input-sm" placeholder={t("dialog.rolePlaceholder")} aria-label={t("dialog.role")} value={r.role} onChange={(e) => update(i, { role: e.target.value })} />}
          {r.kind === "power" && <input className="input input-sm input-xs" type="number" aria-label={t("dialog.powerTier")} value={r.tier} onChange={(e) => update(i, { tier: Number(e.target.value) || 0 })} />}
          <button className="icon-btn" onClick={() => remove(i)} aria-label={t("dialog.removeRule")}>✕</button>
        </div>
      ))}
    </div>
  );
}

// ---------------- Policy editor (the "action gate") ----------------
export function PolicyEditor(
  { value, onChange }: { value: Partial<Policy>; onChange: (p: Partial<Policy>) => void },
) {
  const { t } = useI18n();
  const maxMb = value.maxUploadBytes ? Math.round(value.maxUploadBytes / (1024 * 1024)) : 0;
  return (
    <div className="checks">
      <p className="field-hint">{t("dialog.policyHelp")}</p>
      <label className="check"><input type="checkbox" checked={value.mode === "read-only"} onChange={(e) => onChange({ ...value, mode: e.target.checked ? "read-only" : "active" })} /> {t("dialog.pause")}</label>
      <label className="check"><input type="checkbox" checked={value.attachments === "block"} onChange={(e) => onChange({ ...value, attachments: e.target.checked ? "block" : "allow" })} /> {t("dialog.blockAttachments")}</label>
      <Field label={t("dialog.uploadLimit")}>
        <input className="input input-sm input-xs" type="number" min={0} value={maxMb} onChange={(e) => onChange({ ...value, maxUploadBytes: (Number(e.target.value) || 0) * 1024 * 1024 })} />
      </Field>
    </div>
  );
}

// ---------------- New Room ----------------
export function NewRoomDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const { t } = useI18n();
  const { createRoom, transportId } = useChat();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { activeOrg } = useOrgs();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [combine, setCombine] = useState<"any" | "all">("any");
  const [rules, setRules] = useState<RoomRule[]>([]);
  const [policy, setPolicy] = useState<Partial<Policy>>({});
  return (
    <Modal title={t("dialog.roomTitle")} onClose={onClose} wide>
      {error && <div role="alert" className="error-banner">{translateStatus(t, error)}</div>}
      {transportId === "xmtp" && <p>{t("dialog.gatekeeperHelp")}</p>}
      <Field label={t("dialog.roomName")}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="general" autoFocus /></Field>
      <Field label={t("dialog.description")}><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label={t("dialog.access")} hint={t("dialog.accessHelp")}>
        <select className="input input-sm" value={combine} onChange={(e) => setCombine(e.target.value as any)}>
          <option value="any">{t("dialog.any")}</option>
          <option value="all">{t("dialog.all")}</option>
        </select>
      </Field>
      <GateRuleEditor rules={rules} onChange={setRules} gating={activeOrg.gating} production={transportId === "xmtp"} />
      <div className="section-title">{t("dialog.policy")} <span className="field-hint">{t("dialog.overrideHelp")}</span></div>
      <PolicyEditor value={policy} onChange={setPolicy} />
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>{t("dialog.cancel")}</Button>
        <Button variant="primary" disabled={!title.trim() || busy} onClick={async () => { setBusy(true); setError(null); try { await createRoom({ title: title.trim(), description: description.trim() || undefined, gate: { combine, rules }, policy }); onCreated?.(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : t("dialog.roomFailed")); } finally { setBusy(false); } }}>{t("dialog.createRoom")}</Button>
      </div>
    </Modal>
  );
}

// ---------------- Create Org ----------------
export function CreateOrgDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { addOrg } = useOrgs();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [accent, setAccent] = useState("#F7931A");
  const [chainId, setChainId] = useState(1);
  const [gateUrl, setGateUrl] = useState("");
  const [enableSafe, setEnableSafe] = useState(true);
  const [enableEns, setEnableEns] = useState(true);
  const [usePower, setUsePower] = useState(false);
  const [powerLabel, setPowerLabel] = useState(t("dialog.defaultPowerLabel"));
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
      ? { label: powerLabel || t("dialog.defaultPowerLabel"), resolver: "erc20-votes", tiers: powerTiers.split(",").map((t) => Number(t.trim()) || 0).filter(Boolean) }
      : null,
  };

  const create = () => {
    setError(null);
    try {
      const org = createOrg({ name, accent, chainId, gateUrl: gateUrl.trim() || undefined, entryGate, gating, policy, themeCss: themeCss.trim() || undefined });
      addOrg(org);
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : t("dialog.orgFailed")); }
  };

  return (
    <Modal title={t("dialog.createOrg")} onClose={onClose} wide>
      {error && <div role="alert" className="error-banner">{translateStatus(t, error)}</div>}
      <div className="grid2">
        <Field label={t("dialog.name")}><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme DAO" autoFocus /></Field>
        <Field label={t("dialog.accent")}><input className="input input-color" type="color" value={accent} onChange={(e) => setAccent(e.target.value)} /></Field>
        <Field label={t("dialog.chainId")}><input className="input" type="number" value={chainId} onChange={(e) => setChainId(Number(e.target.value) || 1)} /></Field>
        <Field label={t("dialog.gateUrl")} hint={t("dialog.gateUrlHelp")}><input className="input" value={gateUrl} onChange={(e) => setGateUrl(e.target.value)} placeholder="https://gate.acme.org/api/room-join" /></Field>
      </div>

      <div className="section-title">{t("dialog.capabilities")}</div>
      <div className="checks">
        <label className="check"><input type="checkbox" checked disabled /> {t("dialog.tokenRules")}</label>
        <label className="check"><input type="checkbox" checked={enableSafe} onChange={(e) => setEnableSafe(e.target.checked)} /> {t("dialog.safeRules")}</label>
        <label className="check"><input type="checkbox" checked={enableEns} onChange={(e) => setEnableEns(e.target.checked)} /> {t("dialog.ensRules")}</label>
        <label className="check"><input type="checkbox" checked={usePower} onChange={(e) => setUsePower(e.target.checked)} /> {t("dialog.powerTiers")}</label>
      </div>
      {usePower && (
        <div className="grid2">
          <Field label={t("dialog.powerLabel")}><input className="input" value={powerLabel} onChange={(e) => setPowerLabel(e.target.value)} /></Field>
          <Field label={t("dialog.tiers")}><input className="input" value={powerTiers} onChange={(e) => setPowerTiers(e.target.value)} /></Field>
        </div>
      )}

      <div className="section-title">{t("dialog.entryGate")} <span className="field-hint">{t("dialog.entryHelp")}</span></div>
      <GateRuleEditor rules={entryGate} onChange={setEntryGate} gating={gating} />

      <div className="section-title">{t("dialog.defaultPolicy")} <span className="field-hint">{t("dialog.roomOverrides")}</span></div>
      <PolicyEditor value={policy} onChange={setPolicy} />

      <div className="section-title">{t("dialog.theme")} <span className="field-hint">{t("dialog.themeHelp")}</span></div>
      <textarea aria-label={t("dialog.theme")} className="input textarea" rows={4} value={themeCss} onChange={(e) => setThemeCss(e.target.value)} placeholder={":root { --accent: #F7931A; --bg: #FFFFFF; }"} />

      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>{t("dialog.cancel")}</Button>
        <Button variant="primary" disabled={!name.trim()} onClick={create}>{t("dialog.createOrg")}</Button>
      </div>
    </Modal>
  );
}

// ---------------- Import Org ----------------
export function ImportOrgDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
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
    <Modal title={t("dialog.importOrg")} onClose={onClose} wide>
      <Field label={t("dialog.preset")} hint={t("dialog.presetHelp")}>
        <div className="gate-add">
          {PRESETS.map((p) => (
            <button key={p.label} className="chip" onClick={() => { setText(serializeOrg(p.org)); setError(null); }}>{p.label}</button>
          ))}
        </div>
      </Field>
      <Field label={t("dialog.config")} hint={t("dialog.configHelp")}>
        <textarea className="input textarea" rows={12} value={text} onChange={(e) => { setText(e.target.value); setError(null); }} placeholder='{ "version": 1, "branding": { "name": "..." }, ... }' />
      </Field>
      {error && <div role="alert" className="error-banner">{translateStatus(t, error)}</div>}
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>{t("dialog.cancel")}</Button>
        <Button variant="primary" disabled={!text.trim()} onClick={doImport}>{t("dialog.import")}</Button>
      </div>
    </Modal>
  );
}

export { download };
