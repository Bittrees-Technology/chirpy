import { validateOrgConfig } from "./orgValidation.js";
export { validateOrgConfig, type OrgValidation } from "./orgValidation.js";
import type { GatingConfig, OrgConfig, Policy, RoomRule } from "./types.js";
import { DEFAULT_POLICY, mergePolicy } from "./policy.js";

/** A safe, fully-open default gating config. */
export function openGating(): GatingConfig {
  return {
    enableTokenRules: true,
    enableSafeRules: true,
    enableEnsRules: true,
    roleCascade: {},
    powerTier: null,
  };
}

/** The built-in, org-less default. No gating, no membership — just you. */
export const PERSONAL_ORG: OrgConfig = {
  id: "org_personal",
  version: 1,
  branding: { name: "Personal", slug: "personal", accent: "#F7931A" },
  chain: { chainId: 1 },
  namespace: "personal",
  entryGate: [],
  gating: openGating(),
  policy: { ...DEFAULT_POLICY },
  defaultRooms: [],
  roles: [],
  admins: [],
};

const slugify = (s: string) =>
  String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "org";

const rid = (): string => {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().slice(0, 8);
  } catch { /* ignore */ }
  return Math.abs(Date.parse(new Date().toString()) ^ (performance?.now?.() | 0)).toString(36);
};

export interface CreateOrgInput {
  name: string;
  accent?: string;
  logoUrl?: string;
  homeUrl?: string;
  chainId?: number;
  rpcUrl?: string;
  entryGate?: RoomRule[];
  gating?: Partial<GatingConfig>;
  policy?: Partial<Policy>;
  themeCss?: string;
  admins?: string[];
  gateUrl?: string;
}

/** Produce a fresh OrgConfig from minimal input. */
export function createOrg(input: CreateOrgInput): OrgConfig {
  const slug = slugify(input.name);
  const id = `org_${slug}_${rid()}`;
  return {
    id,
    version: 1,
    branding: {
      name: input.name.trim() || "New Organization",
      slug,
      accent: input.accent || "#F7931A",
      logoUrl: input.logoUrl,
      homeUrl: input.homeUrl,
      themeCss: input.themeCss,
    },
    chain: { chainId: input.chainId ?? 1, rpcUrl: input.rpcUrl },
    namespace: `${slug}:${id}`,
    entryGate: input.entryGate ?? [],
    gating: { ...openGating(), ...(input.gating || {}) },
    policy: mergePolicy(DEFAULT_POLICY, input.policy),
    defaultRooms: [],
    roles: [],
    admins: (input.admins || []).map((a) => a.toLowerCase()),
    gateUrl: input.gateUrl,
  };
}

export function serializeOrg(o: OrgConfig): string {
  return JSON.stringify(o, null, 2);
}

/** Parse + validate JSON text into an OrgConfig. Throws on invalid input. */
export function parseOrg(text: string): OrgConfig {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 256_000) throw new Error("Organization config exceeds the 256 KB import limit.");
  let parsed: any;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error("Invalid JSON"); }
  const v = validateOrgConfig(parsed);
  if (!v.ok) throw new Error(`Invalid org config: ${v.errors.join("; ")}`);
  // Ensure an id exists.
  if (!parsed.id) parsed.id = `org_${slugify(parsed.branding.name)}_${rid()}`;
  parsed.branding.slug ??= slugify(parsed.branding.name);
  parsed.gating = { ...openGating(), ...parsed.gating };
  parsed.defaultRooms ??= [];
  parsed.roles ??= [];
  parsed.admins ??= [];
  // Backward-compat: policy was added after v1 shipped; default it if absent.
  parsed.policy = mergePolicy(DEFAULT_POLICY, parsed.policy);
  return parsed as OrgConfig;
}
