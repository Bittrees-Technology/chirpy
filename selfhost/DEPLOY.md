# Deploying the Chirpy gatekeeper gate

The gate runs the XMTP gatekeeper bot that admits wallets to token-gated rooms. It **must**
run on an always-on host with a modern glibc — **not** Vercel serverless. Verified end-to-end
in a container: `@xmtp/node-sdk`'s native binding needs **GLIBC ≥ 2.38** and the **system CA
bundle** (`ca-certificates`) for its gRPC/TLS, both baked into `gate.Dockerfile` (Debian 13
"trixie"). On Vercel the same code 500s (`GrpcBuilder transport error` / `Cannot find native
binding`) because the serverless runtime has neither.

## 1. Generate the gatekeeper key (keep it secret)

```bash
node selfhost/gen-gatekeeper-key.mjs      # prints the 0x private key + its address
```

Note both: the **private key** → the gate host's `XMTP_GATEKEEPER_PRIVATE_KEY`; the **address**
→ the web app's `VITE_GATEKEEPER_ADDRESS` (step 3) and room super-admin (step 4).

## 2. Deploy the gate

**Fly.io** (see `fly.toml`; run from the repo root):

```bash
fly launch --no-deploy --copy-config --config selfhost/fly.toml      # pick a unique app name
fly secrets set --config selfhost/fly.toml \
    XMTP_GATEKEEPER_PRIVATE_KEY=0x... \
    MAINNET_RPC_URL=https://... \
    GATE_ALLOW_ORIGIN=https://chirpy.bittrees.org
fly deploy --config selfhost/fly.toml --dockerfile selfhost/gate.Dockerfile
curl https://<your-app>.fly.dev/health      # {"ok":true,"gatekeeper":true}
```

**Any Docker host / VPS** (Render, Railway, a droplet, …):

```bash
cd selfhost && ./install.sh                  # prompts → writes gate.env → docker compose up -d --build
# or manually: docker build -f selfhost/gate.Dockerfile -t chirpy-gate . && docker run -d -p 8788:8788 --env-file selfhost/gate.env chirpy-gate
```

Required env (see `gate.env.example`): `XMTP_GATEKEEPER_PRIVATE_KEY`, `MAINNET_RPC_URL`,
`GATE_ALLOW_ORIGIN` (your Chirpy origin). Put it behind TLS (Fly/Render do this for you).

### Local build/test on Apple Silicon — `apple/container` (no Docker Desktop)

[`apple/container`](https://github.com/apple/container) (macOS 15+, ideal on macOS 26) runs the
**same** `gate.Dockerfile` unchanged — it's an OCI runtime. Install once from the signed `.pkg`
on the [latest release](https://github.com/apple/container/releases), then:

```bash
container system start                                  # start the helper (once per login)
container build -t chirpy-gate -f selfhost/gate.Dockerfile .
container run -d --name gt \
  --env XMTP_GATEKEEPER_PRIVATE_KEY=0x... \
  --env MAINNET_RPC_URL=https://... \
  --env GATE_ALLOW_ORIGIN='*' \
  chirpy-gate
container ls                                            # shows the container's IP
curl http://<container-ip>:8788/health                  # {"ok":true,"gatekeeper":true}
```

It runs an arm64 Linux VM — the exact path validated here under Docker (the `linux-arm64-gnu`
binding + glibc 2.41 + `ca-certificates` are baked into `gate.Dockerfile`), so it behaves
identically. `apple/container` is a **local** runtime, not a host: for the always-on production
gate, use a cloud host (above).

## 3. Point the web app at the gate

In the Chirpy Vercel project:

- Set **`VITE_GATEKEEPER_ADDRESS`** = the gatekeeper address from step 1 (so newly created gated
  rooms add the bot as a super-admin). Then redeploy.
- For each gated org, set **`OrgConfig.gateUrl`** = `https://<gate-host>/api/room-join`
  (blank = the app's own `/api/room-join`, which won't work on Vercel — so set it).

## 4. Make the bot a room super-admin

The gatekeeper can only add members to rooms where it's a **super-admin**. New gated rooms get
this automatically once `VITE_GATEKEEPER_ADDRESS` is set; for rooms created before that, add the
gatekeeper address as a super-admin manually.

## Verify

`curl <gate>/health` → `{"ok":true,"gatekeeper":true}`; then in the app, create a gated room and
request to join from a qualifying wallet — the gate verifies the signature, runs `evalGate`, and
adds your inbox.
