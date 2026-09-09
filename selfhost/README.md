# Self-host the gate

An org can run its own **gate service** — the XMTP gatekeeper that admits wallets to
token-gated rooms — instead of using the Vercel deployment's `/api/room-join`. This is
the supported production topology: the gatekeeper requires a durable database and one
coordinated process, provided by an always-on container or VM.

The gate runs the `server/room-join.js` handler the web app expects — it verifies a
wallet signature, evaluates the room's gate with `@app/core`'s `evalGate`, and (as a room
super-admin) adds the wallet's inbox to the XMTP-MLS group.

## What's here

- `gate-server.mjs` — Node HTTP server that wraps `server/room-join.js`; serves `POST /api/room-join` (+ `/health`) with CORS.
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

The web deployment's `/api/room-join` is a fail-closed placeholder. It returns a clear 503 until each organization points to its external gate URL; it never starts a gatekeeper or imports native bindings. Shared server helpers and tests live outside the API route directory.

## Restricted runtime

The final image uses a minimal Node 24 / Debian 13 runtime with no shell or package manager. It runs as UID/GID 65532 (`nonroot`), with pinned base/dependency versions and an npm lockfile. The separate build stage audits the application dependencies before copying them into the runtime image. Docker Compose makes the application filesystem read-only, drops all Linux capabilities, prevents privilege escalation and limits process count. Only `/data` (persistent) and `/tmp` (ephemeral) are writable.

New Docker named volumes inherit the image's `/data` ownership. Before upgrading an existing volume, stop the gate, preserve a backup, and give UID/GID 65532 ownership of its database directory. Other providers, including Fly mounts, must prepare writable ownership for UID 65532. Do not work around ownership failures by running the service as root.

`node scripts/test-gate-container.mjs IMAGE` verifies the built image in isolated containers and removes its test volume afterward. CI requires this check, including a separate dependency audit during the image build; the monorepo audit alone does not cover its separate dependency graph.

The final image is also scanned in CI for high/critical vulnerabilities with a pinned scanner. Lower-severity base-library findings are recorded in `docs/security/container-baseline-2026-09-09.json`; a clean application npm audit is not a whole-image security assessment.
