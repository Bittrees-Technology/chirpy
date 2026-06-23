# Roadmap

Forward-looking items, separate from the shipped v0.

## Shipped (XMTP / production phase)
- ✅ **`XmtpTransport`** — real XMTP DMs + XMTP-MLS gated rooms behind the existing
  `Transport` interface, selected by `VITE_TRANSPORT=xmtp`; no UI change vs mock.
- ✅ **WalletConnect v2 + injected wallet login**, and **ENS** name/avatar resolution.
- ✅ **Serverless gate** — `@app/core`'s `evalGate` wrapped behind HTTP as `api/room-join.js`
  on Vercel (signature-verified, viem `ChainReader`, XMTP gatekeeper bot), plus
  `api/usersync.js` for encrypted cross-device sync.

## Imported in v0
- ✅ **Action policy layer** (read-only rooms, block attachments, size caps).
- ✅ **File-based i18n** (EN/ES), **drop-in CSS theming**, **custom error page**.

## Near-term
- ◐ **Provision prod secrets** (`XMTP_GATEKEEPER_PRIVATE_KEY`, `MAINNET_RPC_URL`, KV) so the
  live deploy runs the gate/sync instead of the mock transport.
- ◐ **Self-host bundle + installer** — `selfhost/` has `install.sh` + compose; still needs
  `gate.Dockerfile` + an HTTP entrypoint wrapping `evalGate`.
- ☐ **Mirror the action policy server-side** (the gate currently trusts client-side enforcement).
- ☐ **SSE realtime fallback** — for non-XMTP surfaces (rooms registry, presence); server-side.

## Later
- **Voice calls (WebRTC)** — neither XMTP nor Push do voice natively, so this is a separate
  build (signaling server + media). A clear differentiator; sequence after the XMTP phase.
- **Per-org relay** — optional reverse proxy in front of the gate for path/method policy +
  censorship-resistance (a reverse-proxy relay pattern), for orgs that want it.
