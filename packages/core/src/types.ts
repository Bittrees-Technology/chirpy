// Org-agnostic domain types. No org (Bittrees or otherwise) is baked in here —
// every org-specific behaviour is expressed as data in an OrgConfig.

/** A single access rule. Mirrors the rule vocabulary the Bittrees gate already
 *  understands, with the org-specific "bgov" tier generalized to "power". */
export type RoomRule =
  | { kind: "token"; standard: "erc20" | "erc721" | "erc1155"; token: string; min: string; tokenId?: string }
  | { kind: "safe"; safe: string }
  | { kind: "ens"; name?: string }
  | { kind: "role"; role: string }
  | { kind: "power"; tier: number };

export type Combine = "any" | "all";

/** A multi-rule gate, as encoded into a room's join URL. */
export interface Gate {
  combine: Combine;
  rules: RoomRule[];
}

export interface Branding {
  /** Display name shown in the org switcher and titlebar. */
  name: string;
  /** Short tag, e.g. "inc", "research", "acme". Used for storage namespacing. */
  slug: string;
  /** Accent color (hex). Drives the app theme when this org is active. */
  accent?: string;
  /** Optional logo URL / data URI. */
  logoUrl?: string;
  /** Optional home/marketing URL. */
  homeUrl?: string;
  /** Optional raw CSS injected when this org is active — drop-in re-skin without a rebuild. */
  themeCss?: string;
}

/**
 * An "action gate" (vs the token "access gate"): what may HAPPEN in a room/org,
 * independent of who may enter. Modeled on the Parley-Chat relay's policy engine.
 */
export interface Policy {
  /** "active" = normal; "read-only" = posting is frozen (e.g. during an incident). */
  mode: "active" | "read-only";
  /** Whether file attachments are permitted. */
  attachments: "allow" | "block";
  /** Max upload size in bytes (undefined / 0 = no cap). */
  maxUploadBytes?: number;
}

export interface ChainConfig {
  chainId: number;
  /** Browser RPC (optional; falls back to a public node). */
  rpcUrl?: string;
}

/** A named voting-power resolver (e.g. Snapshot space, ERC20Votes contract).
 *  The app ships resolvers by id; the org only references one by name. */
export interface PowerTier {
  label: string;            // e.g. "BGOV"
  resolver: string;         // e.g. "snapshot" | "erc20-votes"
  tiers: number[];          // e.g. [1, 69, 210, 420]
  /** Free-form params for the named resolver (space id, token address, ...). */
  params?: Record<string, string>;
}

export interface GatingConfig {
  enableTokenRules: boolean;
  enableSafeRules: boolean;
  enableEnsRules: boolean;
  /** Role name -> rank. A higher rank satisfies a lower room's requirement
   *  (e.g. {partner:3,"junior partner":2,associate:1}). Empty = exact match only. */
  roleCascade: Record<string, number>;
  /** Optional voting-power tier rule (was Bittrees Inc's "bgov"). null = off. */
  powerTier: PowerTier | null;
}

export interface RoleDef {
  label: string;
  color?: string;
}

export interface RoomSeed {
  id: string;
  title: string;
  description?: string;
  /** Gate for the room. Empty rules = open room. */
  gate: Gate;
  /** Optional per-room policy override (merged over the org default). */
  policy?: Partial<Policy>;
}

/** The single object that captures everything org-specific. Importing an org =
 *  importing one of these; creating an org = producing one. */
export interface OrgConfig {
  /** Stable id, e.g. "org_acme". */
  id: string;
  /** Config schema version for forward migration. */
  version: 1;
  branding: Branding;
  chain: ChainConfig;
  /** Storage / KV namespace, e.g. "acme" or "bittrees:research". */
  namespace: string;
  /** Membership gate required to enter the org at all. [] = open. */
  entryGate: RoomRule[];
  gating: GatingConfig;
  /** Org-wide default action policy (rooms may override). */
  policy: Policy;
  defaultRooms: RoomSeed[];
  roles: RoleDef[];
  /** Bootstrap admin addresses (lowercased). */
  admins: string[];
  /** Base URL of the serverless gate (e.g. https://acme.example/api/gate). */
  gateUrl?: string;
}

/** A wallet identity in the app. In mock mode this is generated locally. */
export interface Identity {
  address: string;
  /** Display handle / ENS name if known. */
  handle?: string;
}
