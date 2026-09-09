# Production go-live requirements

Use [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) for implementation evidence and [ROLLOUT-RUNBOOK.md](ROLLOUT-RUNBOOK.md) for promotion and recovery. As of 9 September 2026, web and sync are deployed; an accepted production gate and signed native releases remain outstanding.

## Deployment boundary

Vercel serves the web app and four handlers: health, encrypted user sync, workflow events, and a room-join handler that deliberately returns 503. Native XMTP admission runs only in the durable external gate process in `selfhost/`, using `server/room-join.js`. Gatekeeper keys must stay on that host.

| Location | Configuration |
|---|---|
| Browser build | `VITE_TRANSPORT=xmtp`, `VITE_XMTP_ENV=production`, browser-restricted `VITE_MAINNET_RPC_URL`, `VITE_WALLETCONNECT_PROJECT_ID`, public `VITE_GATEKEEPER_ADDRESS` |
| Web server | Canonical `CHIRPY_BASE_URL`, `CHIRPY_RELEASE_CHANNEL`, `CHIRPY_EXTERNAL_GATE_URL`, `CHIRPY_SYNC_SERVICE_URL=https://<web-host>/api/usersync`, KV URL/token or Upstash equivalents |
| External gate | Persistent wallet key, separate database key, mainnet RPC, exact HTTPS web origin, canonical join URL, nonempty reviewed registry, durable data directory, production network; see [gate environment](../selfhost/gate.env.example) |
| Imported organizations | Exact namespace and external `gateUrl`; every registered room must grant the same gatekeeper super-admin authority |
| Native builds | Explicit HTTPS `VITE_API_ORIGIN`, production browser configuration, signing credentials and release variables; see [NATIVE.md](NATIVE.md) |

Browser-prefixed values ship to users. Use a separate server RPC credential compatible with server access. Secrets belong in the respective host's secret manager. Native CORS requires explicit `CHIRPY_SYNC_ALLOWED_ORIGINS` on the web server and `GATE_NATIVE_ORIGINS` on the gate; neither bypasses signed authorization.

## Data and authority

DMs and Saved Messages follow the wallet across organizations; rooms use exact namespaces. XMTP owns encrypted conversation delivery and installation history. Optional Chirpy sync stores an encrypted settings/snapshot payload, not an automatic backup or transfer of the XMTP database.

Sync v2 grants an in-memory device key at most 24 hours of wallet-authorized access to one service and epoch. Writes bind ciphertext and expected revision. Device and all-device revocation are atomic with writes. Older reusable signatures are rejected; clients must refresh. Existing encrypted payload/key derivation remains compatible and missing revisions start at zero.

The gate database requires its original encryption key, wallet identity, network and persistent storage. Existing plaintext stores need a reviewed offline migration. There is no automatic rekey or destructive migration. Follow [storage recovery](../selfhost/DEPLOY.md#encrypted-database-and-recovery), preserving salt and sidecar files.

Only mainnet token holdings, explicit ERC-1155 IDs, Safe owners and ENS are supported production rules. Preset addresses are illustrative until reviewed. Role, voting-power, delegate and other-chain resolvers remain unavailable. Posting pauses and attachment rules are advisory client policies, not a protocol-wide freeze.

## Release acceptance

- Require green CI, audits, restricted-container tests and expanded XMTP nightly evidence.
- Verify web configuration, live sync authorization/storage and production gate dependencies separately. Web health alone does not prove admission.
- Exercise qualifying and denied wallets, substituted inboxes, replay, restart and wallet/org switching against the intended production room and chain policy.
- Accept operator backup restore, alert delivery and incident ownership. Review membership audit outcomes before enforcement.
- Complete privacy/terms and moderation/retention decisions, signed native artifact/install/updater acceptance and real-device wallet return.

Record date, release/image digest, environment, reviewer and evidence for each acceptance. Merging source code does not satisfy external checks.
