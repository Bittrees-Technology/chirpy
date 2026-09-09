# Deploying the Chirpy gatekeeper gate

This file covers the gate deployment mechanics. For the operator rollout order,
health checks, rollback commands, and incident recovery flow across both the web
and gate surfaces, use [`../docs/ROLLOUT-RUNBOOK.md`](../docs/ROLLOUT-RUNBOOK.md).

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
curl https://<your-app>.fly.dev/health      # HTTP 200 + {"ok":true,"status":"ok",...}
```

**Any Docker host / VPS** (Render, Railway, a droplet, …):

```bash
cd selfhost && ./install.sh                  # prompts → writes gate.env → docker compose up -d --build
# or manually: docker build -f selfhost/gate.Dockerfile -t chirpy-gate . && docker run -d -p 8788:8788 --env-file selfhost/gate.env chirpy-gate
```

Required env (see `gate.env.example`): `XMTP_GATEKEEPER_PRIVATE_KEY`, `MAINNET_RPC_URL`,
`GATE_ALLOW_ORIGIN` (your Chirpy origin). Put it behind TLS (Fly/Render do this for you).

**Persist the XMTP store.** The image writes its XMTP MLS store to `GATE_DATA_DIR` (default
`/data`). Back that path with a durable volume — `docker-compose.yml` declares a `gate-data`
volume, `fly.toml` a `[mounts]` volume (create it once: `fly volumes create gate_data --config
selfhost/fly.toml --region iad --size 1`); on Render/Railway attach a disk mounted at `/data`.
Without a persistent volume the gatekeeper registers a **new XMTP installation on every restart**
and will eventually hit XMTP's per-inbox installation cap.

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
                                                     # missing key or RPC now returns HTTP 503
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

`curl <gate>/health` → HTTP `200` with `"ok": true`; then in the app, create a gated room and
request to join from a qualifying wallet — the gate verifies the signature, runs `evalGate`, and
adds your inbox.

## Encrypted database and recovery

The gate requires a persistent `GATE_DATA_DIR` (the container uses `/data`) and a separate `GATE_DB_ENCRYPTION_KEY`: 32 random bytes encoded as 64 hexadecimal characters. Generate it once using `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` in a private terminal. Store it in the gate's secret configuration, with the wallet key stored separately in your secret manager. Never reuse the wallet key as the database key, put either key in the web deployment, or generate a new database key at each restart. `GATE_XMTP_ENV` defaults to `production`; use separate storage and identities for `dev`.

Run only one gate process against a database. Stop the gate and verify the process has exited before copying its entire data directory, including SQLite sidecar and SQLCipher salt files. Keep the reviewed room registry and deployment configuration with the recovery record, and keep encryption and wallet keys in separately controlled secret backups. Hash the snapshot files and verify the hashes after transfer. Encrypt and restrict access to backups even though the database itself is encrypted. Define and measure your operational backup interval and recovery target before release.

Restore only into a new, empty persistent volume. Preserve file ownership for UID/GID 65532, supply the original wallet key and database key, and start a single gate instance with the original XMTP network. Verify the same installation identity, retained local conversation state, readiness, and a controlled admission before routing production traffic. A wrong key must fail; never delete the database or silently create a replacement identity to recover from an open failure. An existing unencrypted database needs a separately reviewed offline migration; simply adding a key does not migrate it. Keep the original snapshot untouched until migration and recovery acceptance pass.

A repeatable synthetic drill is available after building the gate image:

```sh
XMTP_STORAGE_DRILL=1 node scripts/test-gate-storage.mjs chirpy-gate:local
```

This explicitly uses XMTP **dev**, a newly generated identity, and disposable Docker volumes. It checks encrypted bytes, offline copy integrity, restoration to fresh storage, preservation of the installation and local messages, and wrong-key rejection. It removes its volumes afterward. It does not exercise your production backup service, key custody, routing or operator recovery process.

The SDK intentionally preserves a 32-byte SQLite header. Encryption validation checks that ordinary SQLite cannot query the schema, that the synthetic message is absent from snapshot bytes, and that a wrong key is rejected. A readable file header alone is not evidence of an unencrypted database. See the [upstream SQLCipher connection implementation](https://github.com/xmtp/libxmtp/blob/main/crates/xmtp_db/src/encrypted_store/database/native/sqlcipher_connection.rs).

## Membership lifecycle

Membership maintenance is opt-in: set `GATE_MEMBERSHIP_MODE=audit` first. After reviewing outcomes and accepting the removal policy, set `enforce` to permit removal. The default `off` leaves ongoing membership review to operators. The worker is internal to the existing gate process; there is no public administrative endpoint and it shares the admission queue and native client.

Each pass considers up to 25 members of one registered room, rotates through rooms and member batches, and waits 60 seconds after finishing before the next pass. Large registries take longer to revisit; measure the actual review interval for your deployment. Rooms over 10,000 members require an operator review path. A restart clears pending ineligibility observations, requiring fresh evidence before removal. The worker does not promise immediate revocation after a transfer.

Enforcement requires two confirmed ineligible observations at least five minutes apart under unchanged policy and wallet bindings. Any qualifying bound Ethereum wallet keeps the member eligible. RPC errors, missing/unsupported identities, changed bindings, missing bot authority, and policy changes preserve membership. Room admins, super-admins and the gatekeeper are exempt; operators must manage their roles deliberately. A Safe RPC failure is unknown, not proof of non-ownership. Review aggregate `membership.revalidation` logs (`checked`, `unknown`, `wouldRemove`, `removed`); configure actionable alerts before production enforcement.

Removal affects future group access; it cannot erase already decrypted messages or prevent another administrator from re-adding someone. Enable enforcement only after a reviewed registry, bot permissions and production multi-wallet acceptance are established.

```sh
XMTP_MEMBERSHIP_DRILL=1 node scripts/test-gate-membership.mjs chirpy-gate:local
```

The isolated dev drill verifies actual SDK identity binding and membership changes with fresh wallets, and uses deterministic test balances and a simulated observation clock. It does not prove your production chain RPC, token holdings, room policies or elapsed-time service operation. It removes its test database volume afterward.

## Native gate clients

To support native Chirpy clients, explicitly set `GATE_NATIVE_ORIGINS=tauri://localhost,http://tauri.localhost,https://tauri.localhost`. Keep `GATE_ALLOW_ORIGIN` set to the exact web app origin. The additional list accepts only these platform origins and does not alter signature, inbox, gate or room-policy checks. Native clients are denied by default until configured. Do not use a wildcard or `null` origin.
