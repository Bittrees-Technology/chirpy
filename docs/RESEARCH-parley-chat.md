# Research: Parley-Chat (github.com/Parley-Chat)

A look at the other "Parley Chat" — an **E2EE, self-hostable, censorship-resistant** chat
platform — for transferable lessons. (Also the reason we should rename: the name is taken
by an active project.)

## Their stack

| Repo | Role | Stack |
|---|---|---|
| `sova` | backend | **Python · Flask + Waitress**, SQLite (`db.py` + migrations), `bcrypt` (password auth), self-rolled E2EE (`cryptography`/`cffi`), `nanoid` ids, `Pillow` (pfp/images), `rich` CLI. Docker + docker-compose + nginx + self-SSL. REST `/api/v1` + **SSE** `/api/v1/stream`. Channels, messages, attachments, profile pics, **voice calls** (WebRTC signaling). TOML config, `version.toml`. |
| `mura` | frontend | **Static HTML/JS** — one `index.html` + `quickrun.js`, served statically (`.nojekyll`, GH-Pages style). No framework/build. File-based i18n (`/static/langs`), drop-in theming (`/static/style.css`), custom error pages, sitemap/robots. |
| `relay` | reverse proxy | **Python · Flask + Waitress** in front of `sova` for access control + censorship resistance: declarative per-path/per-method **proxy/block/redirect**, wildcard path matching, upstream HTTP/SOCKS5 proxy, SSE passthrough, file-upload/size blocking, read-only mode. One-liner `install.sh` → systemd + nginx + Let's Encrypt. Persian docs (Iran focus). |
| `installer`, `documentation`, `Landing` | ops/site | installer + docs + marketing. |

**Trust model:** account-based (username + bcrypt password) on a **server you must trust**;
E2EE is self-implemented. They accept EVM donations but are **not** wallet-native.

## What's worth borrowing

1. **Declarative policy layer (their `relay`) — the standout idea.** A config-driven gate in
   front of the API: per-path + per-method `proxy | block | redirect`, wildcard matching,
   read-only mode, attachment/size blocking. We already have a *token* gate; this is an
   *action* gate. Maps cleanly onto an **org-level room/message policy** in `OrgConfig`:
   e.g. mark a room read-only, freeze posting, block attachments, cap upload size — all as
   data. Worth adding a `policy` block to `OrgConfig` + enforcing it in the gate/transport.
2. **Self-host bundle + one-liner installer.** When we ship the serverless gate, also offer a
   **Docker/compose self-host** of the gate (+ KV) with an interactive `install.sh` (prompts →
   writes config → systemd). Lets an org run its own gate instead of Vercel — on-brand for a
   decentralized product and a real differentiator.
3. **SSE for realtime fallback.** They (and Bittrees skillmesh) use Server-Sent Events. Good
   lightweight option for any non-XMTP realtime surface (rooms registry, presence, web fallback).
4. **i18n via static `langs/*.json` + community translations.** Cheap localization (they have
   en/es/toki-pona/uwu/fa/nl). We have none — a tiny `t()` + `langs/*.json` is a low-cost win.
5. **Drop-in CSS theming per deployment.** They re-skin via `style.css` with no rebuild. We
   theme via `OrgConfig.branding.accent`; could extend with an optional `themeCss`/`themeUrl`
   so an org fully re-skins without a build.
6. **Small polish:** custom error pages, sitemap/robots for the web/landing surface;
   `version.toml`-style single source of version (we already mirror this with `APP_VERSION`).
7. **Roadmap idea (feature, not stack):** voice calls via WebRTC signaling — neither XMTP nor
   Push do voice natively, so it'd be a separate build, but it's a clear future differentiator.

## What NOT to adopt (and why our choices hold)

- **Their server + E2EE + password stack is the wrong model for us.** We get **audited E2EE for
  free via XMTP MLS** and **wallet identity** (no passwords, no server to trust). Their hardest
  problems (rolling E2EE, account auth, central-server trust) we sidestep by design.
- **Don't switch to Python/Flask or a no-framework static frontend.** Our **Tauri 2 + React +
  TS** stack is right for native Mac/iOS and for reusing the Bittrees browser chat code
  (XMTP/Push/wagmi). Their static frontend can't host the XMTP browser SDK cleanly.
- **Different threat model.** They optimize for censorship circumvention (relay, SOCKS5, Iran).
  Useful inspiration for an *optional* self-host relay, but not our core differentiator —
  ours is **token-gated, wallet-native, multi-org** chat.

## Net

Borrow the **declarative policy/relay pattern** (→ org room/message policies + a hardened gate)
and the **self-host installer ethos**; treat i18n, drop-in CSS, SSE, and error-page polish as
cheap follow-ups. Their core architecture validates—by contrast—our wallet/XMTP/Tauri choices.
