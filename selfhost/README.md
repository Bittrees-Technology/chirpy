# Self-host the gate

An org can run its own **gate service** — the XMTP gatekeeper that admits wallets to
token-gated rooms — instead of using the Vercel deployment's `/api/room-join`. This is
also the **recommended** way to run the gatekeeper at all: it uses `@xmtp/node-sdk`, whose
native bindings don't run on Vercel's serverless runtime, so an always-on container (or any
VM) is the right home for it.

The gate runs the **same** `api/room-join.js` handler the web app expects — it verifies a
wallet signature, evaluates the room's gate with `@app/core`'s `evalGate`, and (as a room
super-admin) adds the wallet's inbox to the XMTP-MLS group.

## What's here

- `gate-server.mjs` — Node HTTP server that wraps `api/room-join.js`; serves `POST /api/room-join` (+ `/health`) with CORS.
- `gate.Dockerfile` — container image for the gate (Debian/glibc base, so the XMTP native bindings load).
- `docker-compose.yml` — the `gate` service.
- `gate.package.json` — the gate's runtime deps (kept lean, separate from the monorepo).
- `gate.env.example` — environment template.
- `gen-gatekeeper-key.mjs` — generate the gatekeeper bot's keypair.
- `install.sh` — interactive installer: prompts → writes `gate.env` → `docker compose up`.

## Quick start

```bash
cd selfhost
./install.sh                       # prompts, writes gate.env, runs docker compose up -d --build
```

…or manually:

```bash
cd selfhost
node gen-gatekeeper-key.mjs        # note the private key + address
cp gate.env.example gate.env       # fill in the values (incl. the key above)
docker compose up -d --build
curl localhost:8788/health         # HTTP 200 + {"ok":true,"status":"ok",...}
```

Then:

1. Add the **gatekeeper address** as a **super-admin** of each gated room it manages.
2. Point the org's `OrgConfig.gateUrl` at `https://<your-domain>/api/room-join` (blank uses
   the Chirpy deployment's own gate instead).

## Environment (`gate.env`)

| Var | Required | Notes |
|---|---|---|
| `XMTP_GATEKEEPER_PRIVATE_KEY` | ✅ | 0x EOA key for the bot; must be a room super-admin. Generate with `gen-gatekeeper-key.mjs`. |
| `MAINNET_RPC_URL` | ✅ | Unrestricted mainnet RPC for on-chain reads (token/Safe/ENS). Not a browser-allowlisted key. |
| `GATE_ALLOW_ORIGIN` | ↺ | CORS origin of your Chirpy web app (default `*`; set the exact origin in prod). |
| `GATE_PORT` | ↺ | Listen port (default `8788`). |
| `GATE_DOMAIN` | ↺ | Informational; used by your reverse proxy/TLS. |
| `GATE_DATA_DIR` | ↺ | Persistent XMTP MLS store path (default `/data`, backed by a volume). Keeps the gatekeeper's XMTP installation stable across restarts; don't point it at ephemeral storage. |

> Encrypted cross-device **sync** (`api/usersync.js`) is a separate concern that needs a KV
> store; it isn't part of this gate bundle.

`GET /health` now returns HTTP `503` when either `XMTP_GATEKEEPER_PRIVATE_KEY`
or `MAINNET_RPC_URL` is missing, so a green probe means the gate has the minimum
required secrets to serve room joins.

## Why self-host

- **Run the gatekeeper at all** — `@xmtp/node-sdk` needs a runtime with native bindings (a
  container/VM), which Vercel serverless doesn't provide.
- **No Vercel dependency** — run on your own box behind your own nginx/TLS.
- **Censorship-resistance** — optionally front it with a reverse-proxy relay.
