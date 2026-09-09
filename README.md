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

## Product independence contract

- **User and value:** Chirpy serves wallet-native communities that need encrypted direct
  messages and organization-scoped, token-gated rooms without adopting another product.
- **In scope:** the reusable chat client, local preview transport, wallet/XMTP transport,
  organization configuration, gate evaluation, encrypted settings sync, and web/native shells.
- **Out of scope:** Chirpy does not provide governance, treasury, membership issuance, or the
  surrounding websites and operations of any organization.
- **Onboarding and first value:** `pnpm install && pnpm dev` opens the standalone local preview;
  a new user can create a personal or organization space and send a mock message without a
  wallet, network connection, imported preset, or sibling application.
- **Release status:** the live URL is a preview and the repository has an `app-v0.1.0` tag, but
  no published GitHub release. Production messaging still requires the documented runtime
  configuration and external gate for gated-room admission.
- **Trust and support ownership:** Chirpy must own approved support, security, privacy, and
  terms artifacts before exposing those public paths. They are tracked as product blockers in
  [docs/PUBLIC-SURFACE-BLOCKERS.md](docs/PUBLIC-SURFACE-BLOCKERS.md); no claims are implied.
- **Standalone entry and runtime:** the primary entry point is `apps/web`, runnable directly
  with the root `pnpm dev` command and buildable with `pnpm build`; Tauri wraps that same app.
- **No sibling dependency:** building, previewing, and using Chirpy does not require a Bittrees
  Inc, Research, governance, or other sibling checkout or runtime. Bittrees files are examples
  and provenance only.
- **Optional integration boundary:** presets, wallet/XMTP mode, ENS, hosted KV sync, external
  gate services, and embeds are opt-in integrations. The local mock preview remains usable when
  they are absent; enabling an integration does not make a sibling product part of Chirpy.

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
api/           four web handlers; room-join returns 503 and directs deployment to the external gate
server/        shared API logic and durable native gate implementation
selfhost/      restricted gate container, installer, encrypted storage and operator guides
examples/      bittrees-inc.org.json, bittrees-research.org.json  (importable org presets)
docs/          PLAN.md · ARCHITECTURE.md · PRODUCTION.md · ROLLOUT-RUNBOOK.md · ROADMAP.md · NATIVE.md
```

## Status

### Preview vs production

- **Preview default:** `VITE_TRANSPORT` unset, local mock transport, no wallet required, no
  real delivery or community admission.
- **Production target:** `VITE_TRANSPORT=xmtp`, wallet identity, ENS, XMTP DMs/rooms,
  encrypted sync, and an external gatekeeper service for token-gated room joins.
- **Public trust paths:** `/support` and `/security` are implemented, with GitHub private security reporting enabled. Privacy and terms still require approved operator policies.
- **Release status:** implementation and automated evidence are tracked in [the readiness ledger](docs/PRODUCTION-READINESS.md); the production gate and signed native acceptance remain incomplete.

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
- ✅ Gating evaluator (production: mainnet tokens, explicit ERC-1155 IDs, Safe owners and ENS) — `packages/core`.
- ✅ **Action policy** layer (read-only rooms, block attachments, size caps) — pause posting in Chirpy; this is advisory client policy.
- ✅ **Self-hosted token-gate** (`server/room-join.js`): signature-verified `evalGate` + viem chain
  reader + an XMTP gatekeeper bot that adds the inbox to a gated room. Requires a durable external gate deployment.
- ✅ **Encrypted cross-device sync** (`api/usersync.js`): encrypted settings/snapshot payload, key derived
  from a wallet signature, stored in Upstash/Vercel KV with atomic revisions and revocable, expiring device authorization.
- ✅ Per-org **drop-in CSS theming**, a styled **error page**, and an i18n framework (EN/ES).
- ✅ **macOS desktop app** (Tauri 2) with generated icons and **auto-update support** (ed25519
  updater key + GitHub Releases `latest.json`); release CI in `.github/workflows/release.yml`.

### What's left

See [ROADMAP.md](docs/ROADMAP.md) for the current backlog and [PRODUCTION.md](docs/PRODUCTION.md) for release requirements. Production gate hosting/identity/registry, operator recovery/alerts, privacy/terms, signed desktop and real-device iOS acceptance are still required. Incoming receipts, large inbox performance, shared UI/integrations and final artwork remain follow-ups.

Preset token addresses in `examples/` are illustrative until verified. Native CI compiles macOS and generates/builds the iOS project; compilation does not establish device or store acceptance. Release automation requires signing inputs and healthy production services and creates drafts for manual artifact acceptance.

MIT.
