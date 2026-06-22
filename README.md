# Chirpy

**Wallet-native chat for any community — one codebase, a Mac desktop app and an iOS app.**

🌐 **Live:** [chirpy.bittrees.org](https://chirpy.bittrees.org) · skinned with the **Bittrees** brand theme (light surface, Bitcoin-orange accent, treasury-green positives, serif headings).

Chirpy is an **org-agnostic** chat client. It ships with *no* organization baked in:
you start in a personal space, and you can **import** an existing organization's config
or **create** your own — each org brings its own branding, chains, token-gating rules,
roles, and rooms. The chat itself (1:1 DMs + token-gated community rooms) lives inside
every org.

It is built from the chat functionality already shipping in the Bittrees Inc and Bittrees
Research apps (XMTP DMs + Push gated rooms), generalized so those two become nothing more
than **importable presets** (see `apps/web/src/presets.ts` and `examples/`).

> Same web frontend → **web**, **macOS desktop**, and **iOS** via Tauri 2.

---

## Quick start (web — view it now)

```bash
pnpm install
pnpm dev            # → http://localhost:1420
```

Everything works offline in this preview build: the transport is a local mock that
persists per-org to `localStorage`, so you can click around (create an org, import the
Bittrees presets, DM, create gated rooms, react/reply) with **no wallet and no network**.

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
  core/        @app/core      org config model + dependency-free token-gate (ported from Bittrees api/gate.js)
  transport/   @app/transport Transport interface + MockTransport (offline) + XmtpTransport (scaffold)
apps/
  web/         @app/web        Vite + React 19 frontend (used by web + Tauri Mac/iOS)
    src-tauri/                 Tauri 2 native shell (macOS + iOS)
examples/      bittrees-inc.org.json, bittrees-research.org.json  (importable org presets)
docs/          PLAN.md · ARCHITECTURE.md · NATIVE.md
```

## Status (v0)

- ✅ Org-agnostic app shell: personal default, **import org**, **create org** wizard.
- ✅ Chat UI: DMs + rooms, threads, replies, reactions, read state.
- ✅ Cross-org persistence: DMs follow your wallet across all orgs + personal; rooms per org.
- ✅ Generalized gating model + evaluator (token / Safe / ENS / role-cascade / power-tier).
- ✅ **Action policy** layer (read-only rooms, block attachments, size caps) — freeze a room live.
- ✅ Per-org **drop-in CSS theming**, file-based **i18n**, and a styled **error page**.
- ✅ macOS + iOS project (Tauri 2) with generated icons.
- ✅ Desktop **auto-update** (signed, GitHub Releases manifest) — see `docs/NATIVE.md`.
- ◐ **Self-host** gate bundle scaffolded in `selfhost/` (completes with the gate service).
- ⏳ **Next:** wire the real `XmtpTransport` (XMTP DMs + Push rooms) + WalletConnect/ENS, and
  deploy the serverless gate. The UI does not change when this lands — only the transport.
  See `docs/PRODUCTION.md`.

MIT.
