# Roadmap

Forward-looking items, separate from the shipped v0.

## Near-term (production / XMTP phase)
- **Wire `XmtpTransport`** — real XMTP DMs + Push gated rooms behind the existing
  `Transport` interface. Flips `DEFAULT_TRANSPORT` from `mock` to `xmtp`; no UI change.
- **WalletConnect login + ENS sync** (see `docs/PRODUCTION.md`).
- **Serverless / self-hosted gate** — wrap `@app/core`'s `evalGate` behind HTTP; deploy
  to Vercel or via `selfhost/`. The action **policy** model (read-only / attachments /
  size caps) is already enforced client-side and should be mirrored server-side.

## Imported in v0
- ✅ **Action policy layer** (read-only rooms, block attachments, size caps) — done.
- ✅ **File-based i18n**, **drop-in CSS theming**, **custom error page** — done.
- ◐ **Self-host bundle + installer** — scaffolded in `selfhost/`; completes with the gate.
- ☐ **SSE realtime fallback** — for non-XMTP surfaces (rooms registry, presence); server-side.

## Later
- **Voice calls (WebRTC)** — neither XMTP nor Push do voice natively, so this is a separate
  build (signaling server + media). A clear differentiator; sequence after the XMTP phase.
- **Per-org relay** — optional reverse proxy in front of the gate for path/method policy +
  censorship-resistance (a reverse-proxy relay pattern), for orgs that want it.
