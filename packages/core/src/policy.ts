// Action policy — the "what may happen" gate, complementing the token "who may
// enter" gate. A declarative policy model (read-only mode, attachment + size
// limits) applied to our room/org model. Pure logic, fail-closed-ish, no dependencies.

import type { Policy } from "./types.js";

export const DEFAULT_POLICY: Policy = { mode: "active", attachments: "allow" };

/** Merge a partial override on top of a base policy. */
export function mergePolicy(base: Policy, override?: Partial<Policy>): Policy {
  return { ...base, ...(override || {}) };
}

export type PolicyAction =
  | { type: "send" }
  | { type: "attach"; bytes: number };

export interface PolicyDecision {
  allowed: boolean;
  /** Machine code for the denial (for i18n / tests). */
  code?: "read-only" | "attachments-blocked" | "too-large";
  /** Human-readable reason. */
  reason?: string;
}

const ALLOW: PolicyDecision = { allowed: true };

/**
 * Decide whether an action is permitted under a policy. `isAdmin` bypasses
 * read-only (admins can still post in a frozen room) but never bypasses
 * attachment/size limits.
 */
export function evaluatePolicy(
  policy: Policy,
  action: PolicyAction,
  opts: { isAdmin?: boolean } = {},
): PolicyDecision {
  const p = policy || DEFAULT_POLICY;

  if (p.mode === "read-only" && !opts.isAdmin) {
    return { allowed: false, code: "read-only", reason: "This room is read-only." };
  }
  if (action.type === "attach") {
    if (p.attachments === "block") {
      return { allowed: false, code: "attachments-blocked", reason: "Attachments are disabled here." };
    }
    if (p.maxUploadBytes && action.bytes > p.maxUploadBytes) {
      return {
        allowed: false,
        code: "too-large",
        reason: `File exceeds the ${formatBytes(p.maxUploadBytes)} limit.`,
      };
    }
  }
  return ALLOW;
}

/** Short human summary of a policy (for room headers / settings). */
export function policySummary(policy: Policy): string {
  const parts: string[] = [];
  parts.push(policy.mode === "read-only" ? "read-only" : "active");
  if (policy.attachments === "block") parts.push("no attachments");
  if (policy.maxUploadBytes) parts.push(`≤ ${formatBytes(policy.maxUploadBytes)}`);
  return parts.join(" · ");
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}
