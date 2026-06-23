# Architecture

## One idea: org-specifics are data, not code

Every organization difference — branding, chain, token-gating vocabulary, roles, rooms,
KV namespace — is expressed as a single `OrgConfig` object (`@app/core` → `types.ts`).
The app contains **no** organization. You always have a built-in **Personal** org; you can
**import** an `OrgConfig` (paste JSON or pick a preset) or **create** one with the wizard.

This is the direct generalization of what the two Bittrees apps do today: their chat code is
~identical, and the only real differences are the gating rules (Inc's `bgov` voting-power
tiers vs Research's role cascade + membership NFT) and a KV namespace. Those collapse into
`OrgConfig.gating` + `OrgConfig.namespace`. The two apps now live in `examples/` as presets.

## Layers

```
@app/core         pure TS, zero deps
  types.ts        OrgConfig, RoomRule, Gate, GatingConfig, Identity
  gating.ts       evalRule/evalGate — port of Bittrees api/gate.js, chain access injected
                  via a ChainReader interface (so it runs in browser, server, or tests)
  org.ts          createOrg / parseOrg / validateOrgConfig / PERSONAL_ORG

@app/transport    the chat engine boundary
  types.ts        Transport interface (DMs + rooms + reactions + read state + streams)
  mock.ts         MockTransport — offline, localStorage-backed, per-org. Default (no wallet).
  xmtp.ts         XmtpTransport — full impl: encrypted DMs + XMTP-MLS gated group rooms

@app/web          Vite + React 19
  state.tsx       IdentityProvider · OrgProvider · ChatProvider (binds Transport to org)
  views/          List, Thread, Settings, dialogs (New DM / New Room / Create+Import Org)
  presets.ts      Bittrees Inc + Research as importable OrgConfigs
  src-tauri/      Tauri 2 shell (macOS + iOS)
```

## Why a Transport interface

The UI never imports XMTP directly — it talks to `Transport`. `MockTransport` keeps the app
fully viewable offline with no wallet; `XmtpTransport` (encrypted DMs + XMTP-MLS gated rooms)
is selected by `createTransport()` when `VITE_TRANSPORT=xmtp`, and **changes no UI code**.
The gate evaluator in `@app/core` is the production logic; the serverless deploy
(`api/room-join.js`) wraps it with a viem-backed `ChainReader` plus an XMTP gatekeeper bot
that adds the joining inbox to the room.

## Gating model (generalized from Bittrees `api/gate.js`)

A room/org gate is `{ combine: "any"|"all", rules: RoomRule[] }`. Rule kinds:

- `token` — ERC-20 (human `min`, on-chain decimals), ERC-721 (count), ERC-1155 (specific
  id, or "any id" via a `balanceOfBatch` scan of ids 0–255)
- `safe` — Gnosis Safe owners **and** delegates
- `ens` — a specific name, or "any wallet with a primary ENS"
- `role` — admin-assigned role, with an optional **cascade** (`partner ⊇ junior partner ⊇
  associate`) — Bittrees Research's model
- `power` — voting-power tier — Bittrees Inc's `bgov` generalized

Empty rules = open. Evaluation is **fail-closed** (any error → deny), matching the original.
