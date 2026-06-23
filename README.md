# Chirpy

**Wallet-native chat for any community — one codebase across web, a Mac desktop app, and iOS (Tauri 2).**

🌐 **Live:** [chirpy.bittrees.org](https://chirpy.bittrees.org) · skinned with the **Bittrees** brand theme (light surface, Bitcoin-orange accent, treasury-green positives, serif headings).

Chirpy is an **org-agnostic** chat client. It ships with *no* organization baked in:
you start in a personal space, and you can **import** an existing organization's config
or **create** your own — each org brings its own branding, chains, token-gating rules,
roles, and rooms. The chat itself (1:1 DMs + token-gated community rooms) lives inside
every org.

It is built from the chat functionality already shipping in the Bittrees Inc and Bittrees
Research apps (XMTP DMs + token-gated rooms — XMTP-MLS groups joined via a gatekeeper bot),
generalized so those two become nothing more than **importable presets**
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

To run against **real XMTP** (encrypted DMs + MLS rooms), build/serve with
`VITE_TRANSPORT=xmtp` and connect a wallet. Gated-room joins and cross-device sync
additionally require the server env in [docs/PRODUCTION.md](docs/PRODUCTION.md).

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
docs/          PLAN.md · ARCHITECTURE.md · PRODUCTION.md · ROADMAP.md · NATIVE.md
```

## Status

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

- ⏳ **Provision prod secrets** so the live deploy exercises the gate/sync (not just mock):
  `XMTP_GATEKEEPER_PRIVATE_KEY`, `MAINNET_RPC_URL`, and `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
  Until set, `/api/room-join` and `/api/usersync` return 503. Build with `VITE_TRANSPORT=xmtp`
  to select the XMTP transport. See [docs/PRODUCTION.md](docs/PRODUCTION.md).
- ⏳ **iOS**: the Rust shell and icons are ready, but the Xcode project isn't generated yet
  (`pnpm tauri ios init` / `ios dev`). See [docs/NATIVE.md](docs/NATIVE.md).
- ◐ **Self-host bundle** (`selfhost/`): `install.sh` + `docker-compose.yml` are scaffolded but
  still need `selfhost/gate.Dockerfile` + an HTTP entrypoint wrapping `evalGate`. Per-org
  `OrgConfig.gateUrl` is shown in Settings but **not yet consumed** — the client currently
  hardcodes its own origin's `/api/*`.
- ◐ **Release**: CI now builds macOS + Windows + Linux on an `app-v*` tag; Apple notarization
  activates when the `APPLE_*` Actions secrets are set (until then macOS ships updater-signed
  only). No release has been cut yet — push an `app-v*` tag to publish the first one.
- ⚠️ App icons are interim Chirpy artwork (the reusable Bittrees tree mark) pending final brand art.
- ⚠️ Preset token addresses in `examples/` are **illustrative placeholders** (e.g. the Research
  membership token is the burn address) — set real addresses before gating against them.
- ◐ i18n: framework + EN/ES are wired, but only a handful of strings are extracted through `t()`
  so far — broaden coverage.

MIT.
