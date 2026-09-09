# Deploying the Chirpy gate

The native XMTP gate runs on one always-on host with durable storage. Vercel's room-join handler deliberately returns 503; it never loads the native SDK. The tested container supplies the native runtime, runs as UID/GID 65532 and retains filesystem/privilege restrictions.

## Configure a new installation

Install repository dependencies with the pinned pnpm version and use Node 24 or newer for setup. Choose the host, TLS domain, incident owner and secret custody before production activation. Prepare a nonempty reviewed registry using [PRIORITY-FIXES.md](../docs/PRIORITY-FIXES.md); the empty example grants no access.

Run from the repository root:

```sh
bash selfhost/install.sh
```

The installer asks for the HTTPS domain/origin/RPC, reviewed registry and existing wallet key (or explicit generation through a blank response). It writes separate persistent wallet/database keys to mode-600 `selfhost/gate.env` and the public registry to `selfhost/rooms.json`. It refuses existing files and symlinks. Preserve existing identity material rather than rerunning setup over it. Back up both keys separately from the database.

If creating a new identity, configure first without starting, then use the printed public address to establish room super-admin permissions and finish the registry before startup. Creating a room in the UI does not automatically enroll it in the trusted registry.

## Start the supplied Compose deployment

```sh
docker compose -f selfhost/docker-compose.yml --env-file selfhost/gate.env up -d --build
docker compose -f selfhost/docker-compose.yml --env-file selfhost/gate.env ps
curl -fsS https://gate.example.org/health
```

Configure TLS and host firewall routing to the gate port. Compose mounts the database volume at `/data` and the registry read-only at `/config/rooms.json`. Do not omit these mounts or the restrictions when adapting the deployment. Existing volumes must be writable by UID/GID 65532. Never start two processes against one store.

The complete environment is documented in [gate.env.example](gate.env.example). Required values include `XMTP_GATEKEEPER_PRIVATE_KEY`, `GATE_DB_ENCRYPTION_KEY`, `MAINNET_RPC_URL`, `GATE_ALLOW_ORIGIN`, `GATE_PUBLIC_URL`, `CHIRPY_GATE_ROOMS_FILE`, and `GATE_DATA_DIR`. Use `GATE_XMTP_ENV=production` for release.

The Fly configuration is an alternative template requiring a unique app, durable volume, all required secrets, reviewed registry delivery and equivalent single-writer permissions. No Fly or other production gate deployment is established by this repository.

## Route the web app and accept admission

Set the public `VITE_GATEKEEPER_ADDRESS` and `CHIRPY_EXTERNAL_GATE_URL` on the web deployment, rebuild, and set every production organization's `gateUrl` to the matching canonical `https://<gate-host>/api/room-join`. Health metadata does not rewrite organization settings.

Require fresh production dependency readiness, then prove qualifying and denied wallets against the same registered room. Include replay, substituted inbox and restart tests. Follow [ROLLOUT-RUNBOOK.md](../docs/ROLLOUT-RUNBOOK.md) for evidence and recovery.

## Encrypted database and recovery

The gate requires a persistent `GATE_DATA_DIR` (the container uses `/data`) and a separate `GATE_DB_ENCRYPTION_KEY`: 32 random bytes encoded as 64 hexadecimal characters. Generate it once using `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` in a private terminal. Store it in the gate's secret configuration, with the wallet key stored separately in your secret manager. Never reuse the wallet key as the database key, put either key in the web deployment, or generate a new database key at each restart. `GATE_XMTP_ENV` defaults to `production`; use separate storage and identities for `dev`.

Run only one gate process against a database. Stop the gate and verify the process has exited before copying its entire data directory, including SQLite sidecar and SQLCipher salt files. Keep the reviewed room registry and deployment configuration with the recovery record, and keep encryption and wallet keys in separately controlled secret backups. Hash the snapshot files and verify the hashes after transfer. Encrypt and restrict access to backups even though the database itself is encrypted. Define and measure your operational backup interval and recovery target before release.

Restore only into a new, empty persistent volume. Preserve file ownership for UID/GID 65532, supply the original wallet key and database key, and start a single gate instance with the original XMTP network. Verify the same installation identity, retained local conversation state, readiness, and a controlled admission before routing production traffic. A wrong key must fail; never delete the database or silently create a replacement identity to recover from an open failure. An existing unencrypted database needs a separately reviewed offline migration; simply adding a key does not migrate it. Keep the original snapshot untouched until migration and recovery acceptance pass.

### Verify an offline snapshot before restore

After stopping and confirming exit of the only writer, copy the **entire** data directory to a new, private backup directory. Seal that offline copy with the supplied Node 24 utility:

```sh
node selfhost/gate-snapshot.mjs seal /secure/backups/gate-snapshot
```

Store the printed manifest SHA-256 in a separately controlled recovery record, alongside the reviewed deployment/registry version and XMTP network. Keep `chirpy-snapshot.json` with the backup. It records every data file's name, size and SHA-256, including WAL and salt files, and is created with mode 600. Sealing refuses an existing manifest. The utility supports the current flat SDK data directory, up to 10,000 files and a 1 MiB manifest; directories, symbolic links and hard links are rejected.

After transfer, verify using the digest from that separate trusted record:

```sh
node selfhost/gate-snapshot.mjs verify /secure/backups/gate-snapshot TRUSTED_MANIFEST_SHA256
```

Require a successful exit before restoring. Verification rejects changed, missing and extra files, unsafe entries, malformed manifests and a manifest that does not match the trusted digest. Do not regenerate the manifest or take a replacement digest from a failed backup to bypass a failure. Preserve the original backup for investigation.

Copy the verified data files into a new empty restore volume, verify the staged copy with the same manifest/digest, then keep the manifest outside the active data directory when starting the restored gate. Leave the original backup and recovery record untouched. Preserve UID/GID 65532 ownership. A running database will change, so its old backup manifest must not be treated as a current integrity record or carried into a newly sealed snapshot.

The utility does not stop writers, make a live copy atomic, encrypt the backup, authenticate an untrusted recovery record, or establish database/key validity. The existing offline-copy, encryption, separate key custody and actual restore/admission requirements still apply. Schedule and test this process on the selected production host before release.

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

## Operational health

`GET /health` returns 200 only after valid configuration, a nonempty reviewed registry, a fresh mainnet RPC response and live XMTP/super-admin checks pass. Its `dependencies` object reports RPC/XMTP status, check time, in-flight state and registry fingerprint. Results expire after two minutes, and registry changes invalidate previous evidence. A dev gate reports `network: dev` and cannot satisfy production release validation.

Probes start automatically, run again 60 seconds after completion, and share the native work queue while yielding between rooms. Monitor repeated 503 responses and `gate.dependencies` log transitions with your hosting provider's alert delivery. Measure probe duration and admission latency for your real room count before release. A missing host, missing configuration or failed dependency must not be bypassed by disabling the health check.
