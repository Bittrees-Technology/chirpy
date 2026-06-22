import React from "react";

export const shortAddr = (a: string) =>
  a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

export const initials = (s: string) => {
  const clean = (s || "?").replace(/^0x/, "");
  return clean.slice(0, 2).toUpperCase();
};

/** Deterministic color from a string (for avatars). */
export function colorFor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

export function Avatar({ id, label, size = 38, src }: { id: string; label?: string; size?: number; src?: string }) {
  return (
    <div className="avatar" style={{ width: size, height: size, background: colorFor(id), fontSize: size * 0.36 }}>
      <span>{initials(label ?? id)}</span>
      {src && <img src={src} alt={label ?? id} onError={(e) => { e.currentTarget.style.display = "none"; }} />}
    </div>
  );
}

export function Button(
  { children, variant = "default", ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" },
) {
  return <button className={`btn btn-${variant}`} {...rest}>{children}</button>;
}

export function Field(
  { label, hint, children }: { label: string; hint?: string; children: React.ReactNode },
) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle(
  { checked, onChange, label, disabled }:
  { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean },
) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? "checked" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function Modal(
  { title, onClose, children, wide }:
  { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean },
) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

export const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
