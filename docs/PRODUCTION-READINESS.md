# Production readiness execution ledger

We implement and merge independent changes in increasing complexity, while preserving dependency order. A merged implementation is not evidence that an external deployment or device acceptance test has passed.

| Order | Increment | Status / completion evidence |
|---|---|---|
| 1 | HTTP hardening: size/time limits, proxy trust, CORS, sanitized errors, security headers, real HTTP regression tests | Merged in PR #3; 63 tests, type checks, build and rollout proof pass |
| 2 | Keyboard accessibility, message scrolling, translated chat controls | Merged in PR #4; 64 tests and three browser tests pass |
| 3 | Unread counts, request acceptance/rejection, blocking and receipts | DM consent merged in PR #6; unread cursors and visible-message receipt handling merged in PR #7 |
| 4 | Wallet-specific preferences and revocable sync authorization | Wallet isolation merged in PR #8; expiring device authorization and atomic revocation merged in PR #9 |
| 5 | Pagination, bounded refresh, long-history performance | Refresh coalescing merged in PR #12; bounded message pages and history navigation merged in PR #13 |
| 6 | Trusted gate resolvers and protocol-enforceable moderation/membership lifecycle | Supported-rule UI and advisory policy hardening merged in PR #14; opt-in membership revalidation implemented; production activation and operator moderation remain pending |
| 7 | Dependency remediation, live probes, backup/restore and release acceptance | JavaScript dependency patches and required audit merged in PR #10; hosted sync probe passed; backup/restore and full release acceptance pending |
| 8 | Production gate deployment and multi-wallet acceptance | Needs hosting/bot identity and reviewed room registry |
| 9 | Public support/security/privacy/terms material | Support/security pages merged in PR #5 and GitHub private reporting enabled; privacy/terms still need actual operator/retention decisions |
| 10 | Native release/signing, iOS real-device and TestFlight acceptance | Needs release credentials and device/store access |
| 11 | Shared UI/embed and Governance/Research integration | Pending |
| 12 | Final artwork and documentation reconciliation | Pending |
| Later | Voice, presence, optional relays | Product expansion, after core production readiness |

## HTTP hardening acceptance

The real HTTP suite covers malformed and scalar JSON, unsupported content types and methods, compressed bodies, rejected origins/preflights, both declared and streamed oversized payloads, handler exceptions, forged forwarding headers, and bounded server timeout settings. Existing room authorization tests cover signature replay, expiration, incorrect identity/inbox, altered rules, and removed registry entries.

`pnpm test` includes hardening tests and remains required in CI. `pnpm test:hardening` runs the API suites alone for targeted investigation.

The gate now requires an exact `GATE_ALLOW_ORIGIN` for browser access. Wildcard origin configuration is not production-ready. CLI requests without Origin still require the same signed authorization.

Forwarded client addresses are ignored unless the directly connected peer is listed by exact IP in `CHIRPY_TRUSTED_PROXIES`. Only use this setting behind a proxy that appends the real client hop. The last appended address is used; an attacker-supplied prefix cannot evade the limiter. Without a trusted proxy configuration, clients behind the same proxy share a conservative rate bucket. Fleet-wide rate limiting remains pending.

Production web headers disallow object embeds and unauthorized framing, suppress referrers and MIME sniffing, and disable camera/microphone/location until features explicitly need them. The future embed/voice implementation must provide an intentional allowlist rather than remove these protections globally.

## DM consent acceptance

Inbox, Requests and Blocked filters expose XMTP conversation consent. Accept, reject-and-block, block and unblock update the SDK consent state. Unknown or unavailable consent cannot send messages, reactions or receipts. Denied conversations expose no history or list preview. A failed update remains retryable without reporting success. Validation: 70 unit tests, six mock/browser tests, and a two-wallet XMTP dev-network request/accept/reply round trip.

Blocking applies to the direct conversation, not other shared groups or a different identity controlled by the same person. Protocol delivery/storage may continue; Chirpy suppresses display and outgoing activity. Unblocking restores retained history. Existing local `blocked` preference data is not treated as XMTP authorization.

## Unread and receipt acceptance

Unread counts query XMTP's local message database for text/reply messages after the saved read cursor, excluding the current inbox. Cursors retain nanosecond precision and are scoped to wallet, network and conversation on this device. Blocking suppresses counts. Reactions, membership updates and read receipts do not inflate badges.

Read state advances only through a loaded message that is visible at the end of an active, focused conversation. New messages received while the reader is in history or another tab remain unread. Receipt preference controls outgoing receipts independently of local unread state; requests and blocked conversations send neither. Read state is device-local and clearing browser data resets it.

Validation: 75 unit tests, both type checks, six mock/browser tests and two XMTP dev-network tests pass. The two-wallet round trip asserts the recipient's actual unread badge before acceptance. Incoming receipt display and optional per-chat overrides remain follow-up work.

## Wallet-switch isolation

Preferences, local encrypted snapshots and update timestamps are scoped by wallet (or local demo identity). Switching wallets remounts session state and discards in-memory sync keys and pending timers. The active account changes immediately; delayed ENS results cannot restore an old account after switching or disconnecting. Sync key requests reject account mismatches.

The old shared preference/blob keys remain untouched because their owner cannot be determined safely. Each wallet starts with read receipts and sync off and can opt in explicitly. PR #9 subsequently replaced reusable v1 signatures with expiring device authorization and server-side revocation, described below.

Validation: 76 unit tests, both type checks, six mock/browser tests and the two-wallet XMTP dev-network round trip pass. Navigation remains stable during connection while wallet-owned state is remounted. Tests cover account mismatch, malformed stored preferences, late profile responses and returning to a previously used wallet.

## Sync authorization v2

The wallet authorizes a generated device key for one service, wallet, authorization epoch and at most 24 hours. Each write is signed by that device over the ciphertext hash and expected data revision. Device keys stay in memory. Restarting requires re-enabling sync. Old v1 reusable wallet write signatures are rejected; clients must refresh. Existing encrypted blobs and the key-derivation message remain compatible.

Revoking this session creates a server-side denial record until its grant expires. Wallet-signed revoke-all advances a durable authorization epoch without deleting saved data. Every write checks both revocation mechanisms atomically with its data revision, so concurrent revocation cannot be bypassed by a delayed write. If a revocation request fails, the UI distinguishes locally stopped sync from confirmed server revocation.

Production must set `CHIRPY_SYNC_SERVICE_URL` to the canonical HTTPS `/api/usersync` URL. Preview deployments default to their immutable `VERCEL_URL`; open that exact deployment URL when testing sync. Native webviews still need their release-stage API-origin configuration and acceptance tests.


Validation: 88 tests including three real Redis transaction/expiry tests, both type checks, and seven browser tests pass. CI supplies a pinned Redis service and requires the integration tests. The browser sync test verifies wallet/device signatures, encryption envelope handling and both revocation controls. Local Redis integration uses an isolated ephemeral container and removes only synthetic keys it created.

Hosted preview validation exercised signed writes, rejected replay and tampering, per-device revocation, revoke-all, and a fresh grant after revocation against the actual storage service. The synthetic encrypted record and its epoch were removed by a bounded temporary build job. No production user records were changed.

## Dependency security baseline

Patch updates remove all 25 advisories reported by the previous JavaScript dependency audit (eight high and 17 moderate). The resolved graph now reports no known vulnerabilities. The required CI audit fails on moderate or higher findings. Range-scoped overrides cover vulnerable transitive versions while preserving their major versions; Vitest is pinned to 4.1.11. This is a point-in-time dependency check, not a security certification. Native dependency and release checks remain separate.

Validation: both type checks, 88 tests including real Redis race/expiry checks, rollout proof and the production web build pass. Seven browser tests and the two-wallet XMTP dev-network round trip also pass.

## Deployment boundary

Only intended request handlers live in `api/`. Shared server code and API tests are outside the route directory. Vercel and Docker build exclusions omit tests, native build artifacts and local environment files. The web room-join endpoint returns a deliberate 503 without importing native XMTP bindings or TypeScript gate code. Each organization must configure its external gate URL. Web health never claims embedded-gate readiness; the durable gate process has its own health report.

## Bounded refresh

Message notification bursts are debounced into one serial refresh, with one trailing refresh retained when events arrive during active work. Concurrent transport inbox reads share one synchronization. Polling and reconnect signals notify the subscriber instead of synchronizing twice, and background polling pauses while the document is hidden. Returning to the tab triggers refresh. Organization and wallet changes cancel queued refresh work.

Validation: 94 tests include 1,000-event burst/concurrency coverage, failed-refresh retry, session cancellation and hidden-tab polling. Both type checks pass.

## Bounded message history

Threads query and render 50 text/reply messages per page with older/newer/latest navigation. Timestamp ties are kept together, with a hard 1,000-message ceiling and an explicit error for pathological timestamp floods. Queries never exceed 1,001 records; exact nanosecond cursors prevent millisecond rounding gaps. Replies preserve a bounded parent excerpt, and reactions load their target by ID. Reply/read metadata caches are capped at 2,500 entries.

Background refreshes retain the selected history page. Sending returns to the latest page; local reads/receipts do not advance while browsing older history. Switching chats invalidates delayed page results. Validation: 99 tests include a synthetic 100,000-message source, timestamp ties/floods, stale page responses and old-message reactions. Eight browser tests include a 2,000-message history, navigation, bounded rendering and desktop/mobile screenshots; two live XMTP dev-network tests pass. These are bounded pages rather than an unbounded scrolling DOM. Inbox-wide synchronization and very large conversation lists remain performance follow-ups.

## Supported gates and advisory posting policy

The production room editor offers mainnet token holdings, explicit ERC-1155 IDs, Safe owners and ENS. Role/power/delegate sources remain unavailable and are not presented as configured production controls. Send and reaction paths reject unsupported gates. Blank ENS inputs normalize to the documented primary-name rule.

Posting pauses and attachment rules are explicitly Chirpy-client policies. The current XMTP permission API governs membership, administrators and metadata, and provides no posting-permission update. Other clients can ignore a posting pause; no history revocation is promised. Reactions now obey the same gate/policy checks as sends. Super-admins are recognized for policy updates, and local policy changes only after the SDK confirms publication. Automated membership revalidation and an operator moderation/reporting process remain outstanding.

Validation: 104 tests and eight browser tests pass, including unsupported gate controls, paused-room reactions, non-admin denial and failed-policy rollback. Both type checks pass.

## Gate container restrictions

The gate image uses a minimal Node 24 / Debian 13 runtime without shell or package-manager tools, and pins its base digest and separate npm dependency graph. It runs as UID 65532. Compose uses a read-only root filesystem, no Linux capabilities, no privilege escalation, bounded process count and an ephemeral temporary directory. Persistent data ownership is explicit. CI now requires a real container check for native SDK loading, HTTP rejection behavior, filesystem/privilege restrictions, volume persistence across restart and an npm audit in the dependency build stage. This restart check does not yet constitute an XMTP database backup/restore drill.

The full image scan prompted removal of the general-purpose base and bundled package managers. The final image reports zero high/critical findings and zero application JavaScript findings. Trivy still reports 13 medium and seven low base-library findings with no fixed version in the scanned distribution; see `docs/security/container-baseline-2026-09-09.json`. These remain tracked for applicability review and upstream fixes. CI blocks high/critical image findings, including unfixed ones; it does not suppress the recorded medium/low findings.

## Encrypted gate storage

The gate now fails closed without a valid wallet key, a distinct persistent 32-byte database key, an absolute data directory, and a supported XMTP network. The singleton passes the encryption key into the native SDK and rejects unsafe database identifiers. Configuration and concurrency regression tests cover invalid keys, key reuse, retry after initialization failure, and secret-free health output. Existing plaintext databases require a reviewed offline migration; no automatic deletion or identity replacement is provided.

The dev-network storage drill in `scripts/test-gate-storage.mjs` validates a stopped encrypted database copied into fresh storage, retained installation identity and local messages, and rejection of an incorrect key. Production backup scheduling, secret custody, recovery time acceptance and an operator-run restore remain release requirements.

## Safe gate installation

The installer validates domains, HTTPS origins/RPC values and the reviewed registry before writing configuration. It creates distinct persistent keys with exclusive mode-600 writes, preserves existing files and symlinks, and mounts the public room registry read-only. Repeated/invalid setup and dotenv-injection tests protect identity material. Operators still provide the reviewed rooms, TLS routing, key custody and room super-admin permissions.

## Gate work backpressure

Admission uses one shared serial queue with at most 32 waiting operations. Waiting work expires after 10 seconds and overload returns 503 with Retry-After; the caller must obtain a fresh one-use challenge. An active native operation retains its slot until it finishes, so a timeout cannot accidentally create overlapping database writers. Registry policy is reloaded after queue admission and checked again immediately before membership addition; challenge expiry is also checked again. Tests cover saturation, expired waiting work, active-operation exclusion, recovery after failure, and policy removal/expiry during an in-flight eligibility read. Fleet-wide throttling and runtime dependency monitoring remain pending.

## Membership lifecycle implementation

An opt-in internal worker now supports audit and enforcement using the shared gate client/queue. Confirmed nonholders require repeated observations at least five minutes apart; uncertain RPC/identity state preserves membership, administrators are exempt, and policy/identity changes reset removal evidence. Batches and observations are bounded. Maintenance is off until an operator configures and reviews it.

The synthetic XMTP dev drill passed actual wallet-to-inbox binding, eligible-member retention, audit-only outcomes, delayed SDK removal, and gatekeeper protection. Unit tests additionally cover RPC failures, multiple wallets, changed policy/bindings, admin promotion, lost authority, batch limits, shutdown and non-overlapping passes. Production activation, real on-chain multi-wallet acceptance, monitoring and the operator moderation/reporting process remain pending. Previously decrypted history is not revocable.

## Native sync routing

Packaged native apps require `VITE_API_ORIGIN` pointing at the hosted HTTPS origin. The release workflow defaults this to `https://chirpy.bittrees.org` and supports a repository variable override. Web builds retain same-origin routing when unset. Sync refuses credentials, paths in the configured origin, redirects and mismatched server authorization identities; requests omit cookies.

The server allows its canonical service origin plus explicitly configured `CHIRPY_SYNC_ALLOWED_ORIGINS`. Native release origins are `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost`; wildcard/null and unlisted origins are rejected. Preflight allows only GET/POST and Content-Type, with no credentialed CORS. Scoped wallet/device signatures remain required for mutations. See [Tauri's platform URL implementation](https://docs.rs/tauri/latest/src/tauri/manager/mod.rs.html) for the platform origin differences.

Endpoint and CORS tests cover native configuration, untrusted origins, invalid preflights, redirects, service-identity mismatch and signed versus unsigned writes. Native shell/device acceptance, a stricter native content-security policy and signed/notarized distribution remain pending.

## Native dependency audit

The native lockfile updates plist to 1.10.1 (quick-xml 0.42.0) and anyhow to 1.0.104, clearing RUSTSEC-2026-0194, RUSTSEC-2026-0195 and the anyhow unsoundness warning RUSTSEC-2026-0190. The declared minimum Rust version is now 1.88, matching plist's requirement. CI audits the native lockfile with pinned cargo-audit 0.22.2 and retains its report; vulnerability advisories fail the job.

Seven warnings remain visible in `docs/security/native-baseline-2026-09-09.json`: six unmaintained transitive crates and the older glib safety advisory constrained by Tauri's GTK3/Linux dependency graph. They are not suppressed or represented as fixed. Upstream migration and platform applicability review remain release work, particularly for Linux. This audit covers Cargo dependencies, separately from npm and the gate container.
