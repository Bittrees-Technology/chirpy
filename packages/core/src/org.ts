import type { GatingConfig, OrgConfig, Policy, RoomRule } from "./types";
import { DEFAULT_POLICY, mergePolicy } from "./policy";

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
  return {
    id: `org_${slug}_${rid()}`,
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
    namespace: slug,
    entryGate: input.entryGate ?? [],
    gating: { ...openGating(), ...(input.gating || {}) },
    policy: mergePolicy(DEFAULT_POLICY, input.policy),
    defaultRooms: [],
    roles: [],
    admins: (input.admins || []).map((a) => a.toLowerCase()),
    gateUrl: input.gateUrl,
  };
}

export interface OrgValidation { ok: boolean; errors: string[]; }

/** Validate an arbitrary parsed object as an OrgConfig. */
export function validateOrgConfig(o: any): OrgValidation {
  const errors: string[] = [];
  if (!o || typeof o !== "object") errors.push("not an object");
  if (o?.version !== 1) errors.push("unsupported or missing version (expected 1)");
  if (!o?.branding?.name) errors.push("branding.name is required");
  if (!o?.namespace) errors.push("namespace is required");
  if (typeof o?.chain?.chainId !== "number") errors.push("chain.chainId must be a number");
  if (!Array.isArray(o?.entryGate)) errors.push("entryGate must be an array");
  if (!o?.gating) errors.push("gating is required");
  return { ok: errors.length === 0, errors };
}

export function serializeOrg(o: OrgConfig): string {
  return JSON.stringify(o, null, 2);
}

/** Parse + validate JSON text into an OrgConfig. Throws on invalid input. */
export function parseOrg(text: string): OrgConfig {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error("Invalid JSON"); }
  const v = validateOrgConfig(parsed);
  if (!v.ok) throw new Error(`Invalid org config: ${v.errors.join("; ")}`);
  // Ensure an id exists.
  if (!parsed.id) parsed.id = `org_${slugify(parsed.branding.name)}_${rid()}`;
  // Backward-compat: policy was added after v1 shipped; default it if absent.
  parsed.policy = mergePolicy(DEFAULT_POLICY, parsed.policy);
  return parsed as OrgConfig;
}
