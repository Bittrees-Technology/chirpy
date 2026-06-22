# Plan: Generalized Standalone Chat App (`github.com/Bittrees-Technology/chat`)

**Author:** lead · **Date:** 2026-06-22 · **Task:** `plan-chat-app`
**Repo:** `github.com/Bittrees-Technology/chat` (currently empty)
**Sources:** `Bittrees-Inc` (gov.bittrees.org) · `Bittrees-Research` (research.bittrees.org)

---

## 1. Goal

Build **one** standalone, wallet-native chat product that:

1. **Is built from** the chat code that already ships, duplicated, inside Bittrees Inc and
   Bittrees Research — XMTP 1:1 DMs + Push Protocol token-gated community rooms, with a
   Telegram-style shell (requests, reactions, replies, read receipts, encrypted
   cross-device sync).
2. **Runs standalone** at its own domain (e.g. `chat.bittrees.org`) for any wallet, with
   no membership requirement by default.
3. **Integrates back into** Inc and Research as a shared package + an embeddable widget, so
   both apps drop their copy-pasted chat code and consume one source of truth — each
   configured with its own gating rules, rooms, and branding.

The north star: **chat becomes a library + a host app, and the per-org differences
collapse into a config object.**

---

## 2. What exists today (source analysis)

Both source apps carry an almost identical chat layer. Comparing file blob SHAs across the
two repos:

### Byte-identical in both repos (pure shared core — copy/paste drift waiting to happen)
| File | Role |
|---|---|
| `src/lib/xmtp.ts` (~35 KB) | XMTP V3/MLS client: DMs, groups, streams, reactions, replies, read receipts |
| `src/lib/push.ts` / `usePush.ts` | Push Protocol rooms + React hook |
| `src/lib/rooms.ts` | Room model / room list logic |
| `src/lib/dmPrefs.ts` | DM request + preference rules |
| `src/lib/contacts.ts` | Contact list |
| `src/lib/savedMessages.ts` | "Saved messages" self-chat |
| `src/lib/ens.ts` | ENS name/avatar resolution |
| `src/lib/appcrypto.ts` | `@noble/*` encryption for cross-device sync |
| `src/lib/userSync.ts` + `api/usersync.js` | Encrypted cross-device sync |
| `api/community.js`, `api/rooms.js` | KV-backed rooms / roles / moderation registry |

> These are **identical today** (same SHA) but maintained in two places. That is the core
> argument for extraction: a fix to `xmtp.ts` has to be made twice and they will drift.

### Diverging files — and the divergence **is** the tenant seam
| File | Inc | Research | What differs |
|---|---|---|---|
| `src/lib/roomRules.ts` | adds `"bgov"` rule type w/ voting-power `tier` (e.g. 69/210/420) | no tier; gates on membership/BNOTE/BIT + roles | **gate-rule vocabulary** |
| `api/gate.js` | BGOV voting-power tiers | `TIER_RANK = {partner:3, junior partner:2, associate:1}` role cascade; `ROLES_KEY="bittrees:research:roles"` | **gate logic + KV namespace** |
| `src/lib/community.ts` | Inc rooms/roles | Research rooms/roles | default rooms + role set |
| `src/lib/push.ts`* | 15.9 KB | 15.0 KB | tenant room defaults |
| `adminAccess.ts`, `userSync.ts` | minor | minor | namespacing / admin list |

\* `push.ts` SHAs differ slightly; treat as shared core + injected room defaults.

### The serverless gate (`api/gate.js`) is the heart of gating
It is **stateless** — Push Chat does an HTTP GET when a wallet tries to join a gated room
and the function returns **200 (admit) / 403 (deny)**. It already supports a rich rule
vocabulary that is *almost* fully generic:
- `kind: "token"` → ERC-20 (human `min`, reads on-chain decimals), ERC-721 (count),
  ERC-1155 (specific id or "any id" via `balanceOfBatch` scan of ids 0–255)
- `kind: "safe"` → Gnosis Safe owners **and** delegates (signer/proposer)
- `kind: "ens"` → specific name, or "any wallet with a primary ENS"
- `kind: "role"` → admin-assigned roles from KV, with an **optional tier cascade**
- `combine: "any" | "all"` for multi-rule rooms (base64url-encoded gate in the URL)

The **only** non-generic parts are: (a) Inc's `bgov` voting-power tier, (b) the role
cascade table (`TIER_RANK`), and (c) the KV key namespace. All three are config, not code.

### Shared UI (Research has the fuller set)
`RoomGateBuilder.tsx`, `ProposeRoom.tsx`, `PeoplePanel.tsx`, `AddressName.tsx`,
`badges.tsx`, `moderation.tsx`, `multiselect.tsx`, plus a Telegram-style messenger shell.

### Stack (keep it — it's what the chat code is written against)
Vite 6 · React 19 · TypeScript · wagmi 2 / viem 2 · RainbowKit 2 · `@xmtp/browser-sdk` 7 ·
`@pushprotocol/restapi` · `@noble/*` · serverless on **Vercel** + **Upstash KV**.

---

## 3. Target architecture

A small monorepo. One core, one UI kit, one set of serverless handlers, one host app, and a
thin config per consumer.

```
chat/  (github.com/Bittrees-Technology/chat)
├── packages/
│   ├── chat-core/          @bittrees/chat-core  — framework-agnostic TS
│   │     ├── xmtp/         DMs, groups, streams, reactions/replies/receipts
│   │     ├── push/         Push rooms client + room model
│   │     ├── gating/       rule types, RoomRule, gate-URL encode/decode
│   │     ├── sync/         appcrypto + userSync (encrypted cross-device)
│   │     ├── identity/     ens, contacts, address display
│   │     ├── prefs/        dmPrefs, savedMessages
│   │     └── config.ts     ChatTenantConfig type (THE seam — see §4)
│   ├── chat-ui/            @bittrees/chat-ui  — React (Telegram-style shell)
│   │     ├── Messenger/    DM list, thread, composer, requests
│   │     ├── Rooms/        room list, RoomGateBuilder, ProposeRoom
│   │     ├── People/       PeoplePanel, AddressName, badges
│   │     └── theme/        tokens driven by config branding
│   └── chat-gate/          @bittrees/chat-gate — the stateless gate evaluator
│         └── evalRule()    pure functions used by every tenant's /api/gate
├── apps/
│   └── web/                the STANDALONE app (chat.bittrees.org)
│         ├── src/          thin shell: wallet, routing, mounts <Messenger/>
│         ├── api/          gate.js · community.js · rooms.js · usersync.js
│         │                 (each just: import handler from @bittrees/chat-gate
│         │                  + pass this app's ChatTenantConfig)
│         └── chat.config.ts  the standalone tenant config (open/public defaults)
├── examples/
│   ├── inc.config.ts       Bittrees Inc tenant config (BGOV tiers)
│   └── research.config.ts  Bittrees Research tenant config (membership + role cascade)
└── docs/
      └── INTEGRATION.md     how Inc/Research adopt the package
```

**Design rules**
- `chat-core` and `chat-gate` are **pure TypeScript** — no React, no Vite, no Next. They run
  in the browser, in a Vercel function, and in a test runner unchanged. This is what lets
  Inc (Vite SPA), Research (Vite SPA), and any future Next.js app all consume them.
- All tenant-specific behavior flows through **one config object** (§4). No tenant branches
  inside core code.
- KV access is **namespaced by config** (`config.kv.namespace`), so one Upstash store can
  host many tenants without key collisions, or each tenant can point at its own.

---

## 4. The tenant config (the seam that replaces every divergence)

```ts
// @bittrees/chat-core/config.ts
export interface ChatTenantConfig {
  id: string;                       // "bittrees-inc" | "bittrees-research" | "standalone"
  branding: { name: string; logoUrl?: string; theme?: ThemeTokens; homeUrl?: string };

  chain: { chainId: number; rpcUrl?: string };           // server gate RPC is separate env

  kv: { namespace: string };        // e.g. "bittrees:research" → roles key, rooms key, sync

  // Membership gate to ENTER the app at all. Standalone = "none".
  entryGate: RoomRule[] | "none";

  // Gate-rule vocabulary available in the room builder + understood by the gate.
  gating: {
    enableTokenRules: boolean;      // erc20/721/1155 — always on
    enableSafeRules: boolean;
    enableEnsRules: boolean;
    roleCascade?: Record<string, number>;   // Research: {partner:3, "junior partner":2, associate:1}
    powerTier?: {                            // Inc's "bgov": voting-power tier rule
      label: string;                         // "BGOV"
      resolve: PowerResolverRef;             // named server resolver (snapshot/erc20 votes)
      tiers: number[];                       // [1,69,210,420]
    } | null;
  };

  defaultRooms: RoomSeed[];          // per-org seed rooms (was hard-coded in community.ts)
  roles: RoleDef[];                  // per-org assignable roles
  admins: string[];                  // bootstrap admin addresses
}
```

- **Inc** → `powerTier: { label:"BGOV", tiers:[1,69,210,420] }`, no `roleCascade`,
  `entryGate: "none"` (gov is open) , rooms = the BGOV-tiered set.
- **Research** → `powerTier: null`, `roleCascade: {partner:3,"junior partner":2,associate:1}`,
  `entryGate: [{kind:"token",standard:"erc1155",token:<membershipNFT>,min:"1"}]`,
  rooms = membership/BNOTE/BIT set.
- **Standalone** → everything generic on, `powerTier: null`, `roleCascade` optional,
  `entryGate: "none"`, no seed rooms (users create their own).

Generalizing `api/gate.js`: lift `TIER_RANK` into `config.gating.roleCascade`, turn the
`bgov` branch into the optional `powerTier` resolver, and read `ROLES_KEY` from
`config.kv.namespace`. The on-chain reads (token/safe/ens) are already tenant-agnostic.

---

## 5. Integration strategy (how Inc & Research consume it)

Three ways to integrate; we ship **all three surfaces**, recommend #1 + #2.

1. **NPM package (primary).** Inc/Research delete their `src/lib/{xmtp,push,rooms,...}.ts`
   and `api/*.js`, add `@bittrees/chat-core` + `@bittrees/chat-ui` + `@bittrees/chat-gate`,
   and pass their `ChatTenantConfig`. Their `/api/gate` becomes a 3-line re-export. This is
   the real de-duplication win.
2. **Embeddable widget / route.** The standalone `apps/web` can be mounted as a route
   (`/messenger`) or dropped in as an iframe widget for apps that don't want the package.
   Wallet/session is shared via the host's wagmi connection (or wallet re-connect in iframe).
3. **Standalone destination.** `chat.bittrees.org` — full app for anyone, links into Inc /
   Research / Capital rooms when the visitor holds the right tokens.

Because identity is the **wallet + XMTP inbox** (not an app account), a user's DMs and rooms
follow them across all three surfaces automatically — Inc, Research, and standalone are
"views" over the same XMTP/Push state. No data migration needed.

---

## 6. Decisions to confirm (with my recommended defaults)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Framework for the standalone app | **Vite 6 + React 19 SPA** (match source) | Lets us reuse `xmtp.ts` (~35 KB) + every component verbatim; lowest risk. Next.js is possible later but buys nothing for a wallet/browser-SDK chat. |
| D2 | Monorepo tooling | **pnpm workspaces + Turborepo** | Standard, matches other Bittrees monorepos (nftfactory). |
| D3 | Standalone entry gate | **Open (no membership)**; gated rooms still gate | "Generalized" implies usable by any wallet. |
| D4 | KV multi-tenancy | **Namespaced keys in shared Upstash**, per-tenant override allowed | Cheap, simple; isolation via `config.kv.namespace`. |
| D5 | Scope of v1 | **Chat only** (DMs + rooms + sync + gating). Forum/EAS **out** | Forum is a separate concern that also lives in both apps; generalize it in a follow-up. |
| D6 | Package publish target | **GitHub Packages (private)** under `@bittrees/*` | Internal consumers only for now. |

If any of D1/D3/D5 are wrong, the phase plan below changes — flag before Phase 1.

---

## 7. Phased delivery

### Phase 0 — Scaffold & decisions (0.5 wk)
- Confirm §6 decisions. Init monorepo (pnpm + Turbo), TS config, lint, CI on Vercel.
- Seed empty repo: README, `docs/INTEGRATION.md`, this plan.
- **Done when:** `pnpm build` green on empty packages; Vercel preview deploys a "hello chat".

### Phase 1 — Extract `chat-core` + `chat-gate` (1.5 wk)
- Move the byte-identical files from Research into `chat-core` unchanged.
- Introduce `ChatTenantConfig`; replace hard-coded namespace/tiers/rooms with config reads.
- Port `api/gate.js` into `@bittrees/chat-gate` as `evalRule()` + `createGateHandler(config)`;
  lift `TIER_RANK`→`roleCascade`, `bgov`→`powerTier`, `ROLES_KEY`→`config.kv.namespace`.
- Unit tests for every rule kind (erc20 decimals, erc1155 any-id scan, safe owner+delegate,
  ens, role cascade, multi any/all). This is security-critical — gate bugs = access bugs.
- **Done when:** gate test suite passes; core has zero React/tenant imports.

### Phase 2 — `chat-ui` kit (1.5 wk)
- Port the Telegram-style shell + `RoomGateBuilder`, `ProposeRoom`, `PeoplePanel`,
  `AddressName`, `badges`, `moderation`, `multiselect` into `chat-ui`, theming via config.
- Storybook (or a demo route) rendering each component against a mock config.
- **Done when:** all components render in isolation driven only by props + config.

### Phase 3 — Standalone app (`apps/web`) (1.5 wk)
- Wallet connect (RainbowKit), routing, mount `<Messenger/>`, `chat.config.ts` (open tenant).
- Wire `api/{gate,community,rooms,usersync}.js` as thin re-exports of `chat-gate` handlers.
- Cross-device encrypted sync end-to-end (`appcrypto` + `userSync` + `/api/usersync`).
- **Done when:** two fresh wallets DM each other, create a token-gated room, a third wallet
  is correctly admitted/denied, and history syncs to a second device — on a Vercel preview.

### Phase 4 — Integrate into Research, then Inc (2 wk)
- Research first (it's the fuller, role-cascade tenant): swap its `src/lib/*` + `api/*` for
  the packages + `research.config.ts`. Verify membership entry gate, BNOTE/BIT/membership
  rooms, role rooms, DMs, sync — against existing live behavior (no regressions).
- Then Inc with `inc.config.ts` (BGOV power tiers). Verify tiered rooms (≥1/69/210/420).
- **Done when:** both apps run on the packages with identical UX to today and their
  duplicated chat files are deleted.

### Phase 5 — Standalone launch + embed (1 wk)
- Ship `chat.bittrees.org`. Document the iframe/route embed. Cross-link Inc/Research/Capital.
- Runtime monitoring (gate health, KV, XMTP/Push reachability), rate limits on write APIs
  (mirror the per-IP limits the source apps already use).
- **Done when:** public domain live; embed documented; monitors green.

> Rough total: ~8–9 weeks of focused work. Phases 1–3 are the build; 4 is the payoff
> (de-dup); 5 is launch. Phases can compress with parallel agents (UI vs core vs app).

---

## 8. Risks & mitigations
- **XMTP V3/MLS churn** — browser SDK 7 is moving fast; pin versions, wrap the SDK behind
  `chat-core/xmtp` so upgrades touch one module.
- **Gate correctness = security** — a wrong 200 leaks a gated room. Mitigate with the Phase 1
  test matrix + an adversarial review of `evalRule`. Keep the gate **stateless & fail-closed**
  (it already returns 403 on any error).
- **Push Protocol changes / room-id custody** — room chatIds are created once by an admin and
  stored in KV; back them up (the source apps store them in `VITE_PUSH_ROOM_*` + KV registry).
- **KV multi-tenant collisions** — enforced namespace prefix; add a startup assertion that
  `config.kv.namespace` is set and non-default.
- **Key custody for cross-device sync** — `appcrypto` derives from a wallet signature; document
  the threat model; never store plaintext server-side.
- **Server RPC vs browser RPC** — already a known footgun (gate must use unrestricted
  `MAINNET_RPC_URL`, not the domain-allowlisted `VITE_` key). Bake into config/env docs.
- **Drift during migration** — freeze chat changes in Inc/Research during Phase 4; land the
  swap behind a feature flag so rollback is instant.

---

## 9. Env / config surface (from the source apps)
- `MAINNET_RPC_URL` (server, **unrestricted**) · `VITE_MAINNET_RPC_URL` (browser) ·
  `VITE_WALLETCONNECT_PROJECT_ID`
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Upstash) — namespaced per tenant
- `VITE_GATE_URL` (default `/api/gate`) · per-room Push chat ids (created once by admin)
- Standalone adds: `CHAT_TENANT=standalone`, optional allowlist of embeddable origins.

---

## 10. Immediate next actions
1. Get §6 decisions confirmed (esp. D1 Vite-vs-Next, D3 open standalone, D5 chat-only v1).
2. I scaffold the monorepo in `github.com/Bittrees-Technology/chat` and open a PR with the
   structure in §3 + this plan in `docs/`.
3. Start Phase 1 extraction from `Bittrees-Research` (the fuller tenant).

---
*Grounded in a direct read of `Bittrees-Inc` and `Bittrees-Research` (`src/lib/*`, `api/*`,
`src/components/*`) on 2026-06-22.*
