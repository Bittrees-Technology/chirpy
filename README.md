# Chirpy

**Wallet-native community chat: encrypted 1:1 DMs, token-gated rooms, and portable org spaces across web, macOS, and iOS (Tauri 2).**

🌐 **Live preview:** [chirpy.bittrees.org](https://chirpy.bittrees.org)

Chirpy is an **org-agnostic** chat client for communities that organize around wallets.
You start in a personal space, then **import** an existing organization's config or
**create** your own. Each org brings its own branding, chains, token-gating rules,
roles, and rooms; your 1:1 DMs stay attached to your wallet while community rooms
remain scoped to the org that gates them.

The implementation is generalized from chat functionality used by Bittrees Inc and
Bittrees Research. Bittrees is provenance and an included preset, not the product's
primary frame: Chirpy is meant to be reusable by any wallet-native community
(see `apps/web/src/presets.ts` and `examples/`).

> Same web frontend → **web**, **macOS desktop**, and **iOS** via Tauri 2.

---

## Quick start (web — view it now)

```bash
pnpm install
pnpm dev            # → http://localhost:1420
```

Everything works offline in this preview build: the **default** transport is a local mock
that persists per-org to `localStorage`, so you can click around (create an org, import the
Bittrees presets, DM, create gated rooms, react/reply) with **no wallet and no network**.

Production-style messaging is implemented behind `VITE_TRANSPORT=xmtp`: encrypted DMs,
XMTP-MLS rooms, wallet login, ENS profiles, and wallet-encrypted sync. A production
deployment is not just a static build, though. It requires the browser/KV env plus a
self-hosted external gate for gated-room joins as documented in
[docs/PRODUCTION.md](docs/PRODUCTION.md) and
[docs/ROLLOUT-RUNBOOK.md](docs/ROLLOUT-RUNBOOK.md).

```bash
pnpm build          # production web build → apps/web/dist
pnpm typecheck      # type-check the whole workspace
```

## Mac & iOS (native)

See **[docs/NATIVE.md](docs/NATIVE.md)**. In short:

```bash
pnpm tauri dev          # run the macOS desktop app (needs Rust)
pnpm tauri build        # build Chirpy.app / .dmg
pnpm tauri ios init     # scaffold the iOS project (needs Xcode)
pnpm tauri ios dev      # run in the iOS Simulator
```

---

## Workspace

```
packages/
  core/        @app/core      org config model + dependency-free token-gate + action policy
  transport/   @app/transport Transport interface + MockTransport (offline) + XmtpTransport (full XMTP-MLS impl)
apps/
  web/         @app/web        Vite + React 19 frontend (used by web + Tauri Mac/iOS)
    src-tauri/                 Tauri 2 native shell (macOS + iOS)
api/           room-join.js (serverless token-gate), usersync.js (encrypted device sync) — Vercel functions
selfhost/      Docker self-host bundle for the gate (scaffold — see "What's left")
examples/      bittrees-inc.org.json, bittrees-research.org.json  (importable org presets)
docs/          PLAN.md · ARCHITECTURE.md · PRODUCTION.md · ROLLOUT-RUNBOOK.md · ROADMAP.md · NATIVE.md
```

## Status

### Preview vs production

- **Preview default:** `VITE_TRANSPORT` unset, local mock transport, no wallet required, no
  real delivery or community admission.
- **Production target:** `VITE_TRANSPORT=xmtp`, wallet identity, ENS, XMTP DMs/rooms,
  encrypted sync, and an external gatekeeper service for token-gated room joins.
- **Public trust paths:** `/support`, `/security`, `/privacy`, and `/terms` are not shipped
  as placeholder SPA routes. Add real approved artifacts before linking or routing them;
  see [docs/PUBLIC-SURFACE-BLOCKERS.md](docs/PUBLIC-SURFACE-BLOCKERS.md).

### Done

- ✅ Org-agnostic app shell: personal default, **import org**, **create org** wizard.
- ✅ Chat UI: DMs + rooms, threads, replies, reactions, read state — with bottom-anchored
  messages, sent/received bubble alignment, and ENS-resolved names + avatars.
- ✅ **Real XMTP transport** (`packages/transport/src/xmtp.ts`): encrypted DMs + XMTP-MLS
  group rooms, including one-click recovery from XMTP's 10-installation inbox limit.
- ✅ **Wallet + identity**: injected EIP-1193 wallets and **WalletConnect v2**
  (`walletProviders.ts`); **ENS** name + avatar resolution and reverse lookup
  (`ens.ts`, `useEns.ts`).
- ✅ Cross-org persistence: DMs follow your wallet across all orgs + personal; rooms per org.
- ✅ Generalized gating model + evaluator (token / Safe / ENS / role-cascade / power-tier) — `packages/core`.
- ✅ **Action policy** layer (read-only rooms, block attachments, size caps) — freeze a room live.
- ✅ **Serverless token-gate** (`api/room-join.js`): signature-verified `evalGate` + viem chain
  reader + an XMTP gatekeeper bot that adds the inbox to a gated room. Deployed on Vercel.
- ✅ **Encrypted cross-device sync** (`api/usersync.js`): settings + saved messages, key derived
  from a wallet signature, stored in Upstash/Vercel KV (last-write-wins with a stale guard).
- ✅ Per-org **drop-in CSS theming**, a styled **error page**, and an i18n framework (EN/ES).
- ✅ **macOS desktop app** (Tauri 2) with generated icons and signed **auto-update** (ed25519
  updater key + GitHub Releases `latest.json`); release CI in `.github/workflows/release.yml`.

### What's left

- ⏳ **Provision the production web env plus the external gate** so the live deploy exercises
  XMTP and sync (not just mock): the web surface needs the browser and KV values documented in
  [docs/PRODUCTION.md](docs/PRODUCTION.md), and production gated orgs must point `gateUrl` at
  the self-hosted gate described in [docs/ROLLOUT-RUNBOOK.md](docs/ROLLOUT-RUNBOOK.md).
  The same-origin Vercel `/api/room-join` path is not a supported production gatekeeper target.
- ⏳ **iOS**: the Rust shell and icons are ready, but the Xcode project isn't generated yet
  (`pnpm tauri ios init` / `ios dev`). See [docs/NATIVE.md](docs/NATIVE.md).
- ✅ **Self-host bundle** (`selfhost/`): `gate.Dockerfile` + `gate-server.mjs` (a working Node
  HTTP wrapper around `api/room-join.js` with CORS) are built and documented in
  `selfhost/DEPLOY.md`. Per-org `OrgConfig.gateUrl` is consumed by the client
  (`packages/transport/src/xmtp.ts` `gateEndpoint()`) — point it at a self-hosted gate to route
  around the Vercel serverless limitation below.
- ◐ **Release**: CI now builds macOS + Windows + Linux on an `app-v*` tag; Apple notarization
  activates when the `APPLE_*` Actions secrets are set (until then macOS ships updater-signed
  only). No release has been cut yet — push an `app-v*` tag to publish the first one.
- ⚠️ App icons are interim Chirpy artwork (the reusable Bittrees tree mark) pending final brand art.
- ⚠️ Preset token addresses in `examples/` are **illustrative placeholders** (e.g. the Research
  membership token is the burn address) — set real addresses before gating against them.
- ◐ i18n: framework + EN/ES are wired, but only a handful of strings are extracted through `t()`
  so far — broaden coverage.

MIT.
