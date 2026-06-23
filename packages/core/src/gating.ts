// Generalized port of the Bittrees stateless token-gate (api/gate.js).
// Pure logic: all chain access is delegated to an injected ChainReader, so this
// module has zero dependencies and runs in the browser, a serverless function,
// or a test runner unchanged. The production gate provides a viem-backed reader;
// the app provides a mock reader for previews.

import type { Combine, Gate, GatingConfig, RoomRule } from "./types.js";

export interface ChainReader {
  erc20Balance(token: string, user: string): Promise<bigint>;
  erc20Decimals(token: string): Promise<number>;
  /** ERC-721 & ERC-20 share balanceOf(address)->uint256. */
  erc721Balance(token: string, user: string): Promise<bigint>;
  erc1155Balance(token: string, user: string, id: bigint): Promise<bigint>;
  /** Sum of balances across ids 0..255 — the "any token id" check. */
  erc1155BalanceAny(token: string, user: string): Promise<bigint>;
  safeOwners(safe: string): Promise<string[]>;
  safeDelegates(safe: string): Promise<string[]>;
  ensAddress(name: string): Promise<string | null>;
  /** Primary (reverse) ENS name for an address, or null. */
  ensName(user: string): Promise<string | null>;
  /** Roles assigned to a user (lowercased labels). */
  rolesOf(user: string): Promise<string[]>;
  /** Voting power for a user under the org's configured resolver. */
  power(user: string): Promise<number>;
}

const isAddr = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(String(s || ""));

/** Convert a human ERC-20 amount to base units given decimals, as bigint. */
export function humanToUnits(min: string, decimals: number): bigint {
  const s = String(min ?? "0").trim();
  if (!s) return 0n;
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, Math.max(0, decimals));
  const digits = (whole.replace(/[^0-9]/g, "") || "0") + fracPadded;
  let v = 0n;
  try { v = BigInt(digits || "0"); } catch { v = 0n; }
  return neg ? -v : v;
}

/**
 * Whether `user` satisfies a required role under a cascade table. A holder of an
 * equal-or-higher rank passes a lower room's requirement; other roles match exactly.
 */
export function satisfiesRole(
  userRoles: string[],
  required: string,
  cascade: Record<string, number>,
): boolean {
  const want = String(required || "").trim().toLowerCase();
  const have = (userRoles || []).map((r) => String(r || "").trim().toLowerCase());
  const wantRank = cascade[want];
  if (wantRank) {
    return have.some((r) => {
      const rank = cascade[r];
      return rank ? rank >= wantRank : false;
    });
  }
  return have.includes(want);
}

/** Evaluate a single rule for `user` (lowercased ok). Fail-closed on any error. */
export async function evalRule(
  rule: RoomRule,
  user: string,
  reader: ChainReader,
  gating: Pick<GatingConfig, "roleCascade" | "powerTier">,
): Promise<boolean> {
  try {
    if (rule.kind === "role") {
      const roles = await reader.rolesOf(user);
      return satisfiesRole(roles, rule.role, gating.roleCascade || {});
    }
    if (rule.kind === "power") {
      if (!gating.powerTier) return false;
      return (await reader.power(user)) >= rule.tier;
    }
    if (rule.kind === "safe") {
      if (!isAddr(rule.safe)) return false;
      const [owners, delegates] = await Promise.all([
        reader.safeOwners(rule.safe),
        reader.safeDelegates(rule.safe),
      ]);
      const u = user.toLowerCase();
      return owners.map((o) => o.toLowerCase()).includes(u) ||
        delegates.map((d) => d.toLowerCase()).includes(u);
    }
    if (rule.kind === "ens") {
      if (rule.name) {
        const addr = await reader.ensAddress(rule.name);
        return !!addr && addr.toLowerCase() === user.toLowerCase();
      }
      return !!(await reader.ensName(user)); // any wallet with a primary ENS
    }
    if (rule.kind === "token") {
      if (!isAddr(rule.token)) return false;
      if (rule.standard === "erc1155") {
        let min: bigint; try { min = BigInt(rule.min || "1"); } catch { min = 1n; }
        if (rule.tokenId === undefined || rule.tokenId === "") {
          return (await reader.erc1155BalanceAny(rule.token, user)) >= min;
        }
        let id: bigint; try { id = BigInt(rule.tokenId); } catch { id = 0n; }
        return (await reader.erc1155Balance(rule.token, user, id)) >= min;
      }
      if (rule.standard === "erc20") {
        const decimals = await reader.erc20Decimals(rule.token);
        const min = humanToUnits(rule.min || "0", decimals);
        return (await reader.erc20Balance(rule.token, user)) >= min;
      }
      // erc721 -> min is a token count
      let min: bigint; try { min = BigInt(rule.min || "1"); } catch { min = 1n; }
      return (await reader.erc721Balance(rule.token, user)) >= min;
    }
  } catch {
    return false;
  }
  return false;
}

/** Evaluate a full gate. Empty rules = open (admit). Fail-closed otherwise. */
export async function evalGate(
  gate: Gate,
  user: string,
  reader: ChainReader,
  gating: Pick<GatingConfig, "roleCascade" | "powerTier">,
): Promise<boolean> {
  const rules = Array.isArray(gate?.rules) ? gate.rules : [];
  if (rules.length === 0) return true;
  const results = await Promise.all(rules.map((r) => evalRule(r, user, reader, gating)));
  return gate.combine === "all" ? results.every(Boolean) : results.some(Boolean);
}

// --- gate URL encoding (UTF-8 safe base64url), matching the Bittrees scheme ---

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa exists in browsers & Node 16+. Fallback to Buffer if present.
  if (typeof btoa === "function") return btoa(bin);
  return (globalThis as any).Buffer.from(bytes).toString("base64");
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === "function"
    ? atob(b64)
    : (globalThis as any).Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeGate(gate: Gate): string {
  const json = JSON.stringify(gate);
  const b64 = bytesToBase64(new TextEncoder().encode(json));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeGate(b64url: string): Gate {
  try {
    const b64 = String(b64url || "").replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(base64ToBytes(b64));
    const parsed = JSON.parse(json);
    return {
      combine: parsed.combine === "all" ? "all" : "any",
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    };
  } catch {
    return { combine: "any", rules: [] };
  }
}

/** Human-readable one-line summary of a rule (for the room builder UI). */
export function ruleSummary(rule: RoomRule): string {
  switch (rule.kind) {
    case "token":
      return `Hold ${rule.min} ${rule.standard.toUpperCase()}${rule.tokenId ? ` #${rule.tokenId}` : ""} @ ${short(rule.token)}`;
    case "safe": return `Owner/delegate of Safe ${short(rule.safe)}`;
    case "ens": return rule.name ? `Resolves ${rule.name}` : "Has a primary ENS name";
    case "role": return `Role: ${rule.role}`;
    case "power": return `Voting power ≥ ${rule.tier}`;
  }
}
const short = (a: string) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
