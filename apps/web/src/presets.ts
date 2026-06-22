import type { OrgConfig } from "@app/core";

// IMPORTANT: the app itself is org-agnostic — nothing here is loaded by default.
// These are *importable* example org configs that demonstrate how the two real
// Bittrees apps map onto a single OrgConfig. A user picks one in Import → it
// becomes just another org in their switcher. Addresses are illustrative.

export const bittreesResearchPreset: OrgConfig = {
  id: "org_bittrees_research",
  version: 1,
  branding: { name: "Bittrees Research", slug: "research", accent: "#10b981", homeUrl: "https://research.bittrees.org" },
  chain: { chainId: 1 },
  namespace: "bittrees:research",
  // Membership NFT required to enter the org (ERC-1155, any id).
  entryGate: [{ kind: "token", standard: "erc1155", token: "0x000000000000000000000000000000000000dEaD", min: "1" }],
  gating: {
    enableTokenRules: true,
    enableSafeRules: true,
    enableEnsRules: true,
    // Tier roles cascade: Partner ⊇ Junior Partner ⊇ Associate.
    roleCascade: { partner: 3, "junior partner": 2, associate: 1 },
    powerTier: null,
  },
  roles: [
    { label: "Partner", color: "#f59e0b" },
    { label: "Junior Partner", color: "#3b82f6" },
    { label: "Associate", color: "#10b981" },
    { label: "Researcher", color: "#a855f7" },
  ],
  defaultRooms: [
    { id: "research-lobby", title: "lobby", description: "All members", gate: { combine: "any", rules: [] } },
    { id: "research-associates", title: "associates", description: "Associate tier and up", gate: { combine: "any", rules: [{ kind: "role", role: "associate" }] } },
    { id: "research-researchers", title: "researchers", description: "Researcher role", gate: { combine: "any", rules: [{ kind: "role", role: "researcher" }] } },
  ],
  admins: [],
  gateUrl: "https://research.bittrees.org/api/gate",
};

export const bittreesIncPreset: OrgConfig = {
  id: "org_bittrees_inc",
  version: 1,
  branding: { name: "Bittrees, Inc.", slug: "inc", accent: "#eab308", homeUrl: "https://gov.bittrees.org" },
  chain: { chainId: 1 },
  namespace: "bittrees:inc",
  entryGate: [], // governance is open
  gating: {
    enableTokenRules: true,
    enableSafeRules: true,
    enableEnsRules: true,
    roleCascade: {},
    // BGOV voting-power tiers (the original "bgov" rule generalized).
    powerTier: { label: "BGOV", resolver: "snapshot", tiers: [1, 69, 210, 420], params: { space: "gov.bittrees.eth" } },
  },
  roles: [{ label: "Operations", color: "#ef4444" }],
  defaultRooms: [
    { id: "inc-shareholders", title: "shareholders", description: "≥ 1 BGOV", gate: { combine: "any", rules: [{ kind: "power", tier: 1 }] } },
    { id: "inc-associates", title: "associates", description: "≥ 69 BGOV", gate: { combine: "any", rules: [{ kind: "power", tier: 69 }] } },
    { id: "inc-partners", title: "partners", description: "≥ 210 BGOV", gate: { combine: "any", rules: [{ kind: "power", tier: 210 }] } },
    { id: "inc-board", title: "board", description: "≥ 420 BGOV", gate: { combine: "any", rules: [{ kind: "power", tier: 420 }] } },
  ],
  admins: [],
  gateUrl: "https://gov.bittrees.org/api/gate",
};

export const PRESETS: { label: string; org: OrgConfig }[] = [
  { label: "Bittrees Research", org: bittreesResearchPreset },
  { label: "Bittrees, Inc.", org: bittreesIncPreset },
];
