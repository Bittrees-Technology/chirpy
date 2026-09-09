# Production readiness execution ledger

See [REMAINING-WORK.md](REMAINING-WORK.md) for the consolidated unfinished backlog. We implement and merge independent changes in increasing complexity, while preserving dependency order. A merged implementation is not evidence that an external deployment or device acceptance test has passed.

| Order | Increment | Status / completion evidence |
|---|---|---|
| 1 | HTTP hardening: size/time limits, proxy trust, CORS, sanitized errors, security headers, real HTTP regression tests | Merged in PR #3; 63 tests, type checks, build and rollout proof pass |
| 2 | Keyboard accessibility, message scrolling, translated chat controls | Merged in PR #4; 64 tests and three browser tests pass |
| 3 | Unread counts, request acceptance/rejection, blocking and receipts | DM consent merged in PR #6; unread cursors and visible-message receipt handling merged in PR #7 |
| 4 | Wallet-specific preferences and revocable sync authorization | Wallet isolation merged in PR #8; expiring device authorization and atomic revocation merged in PR #9 |
| 5 | Pagination, bounded refresh, long-history performance | Refresh coalescing merged in PR #12; bounded message pages and history navigation merged in PR #13 |
| 6 | Trusted gate resolvers and protocol-enforceable moderation/membership lifecycle | Supported-rule UI and advisory policy hardening merged in PR #14; opt-in membership revalidation implemented; production activation and operator moderation remain pending |
| 7 | Dependency remediation, live probes, backup/restore and release acceptance | JavaScript dependency patches and required audit merged in PR #10; hosted sync probe passed; synthetic encrypted backup/restore and live readiness implemented in PRs #16/#24; operator recovery and release acceptance pending |
| 8 | Production gate deployment and multi-wallet acceptance | Needs hosting/bot identity and reviewed room registry |
| 9 | Public support/security/privacy/terms material | Support/security pages merged in PR #5 and GitHub private reporting enabled; privacy/terms still need actual operator/retention decisions |
| 10 | Native release/signing, iOS real-device and TestFlight acceptance | Needs release credentials and device/store access |
| 11 | Shared UI/embed and Governance/Research integration | Consumer inspection and migration contract in INTEGRATION.md; history/authority decisions and implementation pending |
| 12 | Final artwork and documentation reconciliation | Operations/roadmap/native guides reconciled; final artwork pending |
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

Validation: 75 unit tests, both type checks, six mock/browser tests and two XMTP dev-network tests pass. The two-wallet round trip asserts the recipient's actual unread badge before acceptance. Per-chat overrides and incoming peer receipt times are now implemented.

## Wallet-switch isolation

Preferences, local encrypted snapshots and update timestamps are scoped by wallet (or local demo identity). Switching wallets remounts session state and discards in-memory sync keys and pending timers. The active account changes immediately; delayed ENS results cannot restore an old account after switching or disconnecting. Sync key requests reject account mismatches.

The old shared preference/blob keys remain untouched because their owner cannot be determined safely. Each wallet starts with read receipts and sync off and can opt in explicitly. PR #9 subsequently replaced reusable v1 signatures with expiring device authorization and server-side revocation, described below.

Validation: 76 unit tests, both type checks, six mock/browser tests and the two-wallet XMTP dev-network round trip pass. Navigation remains stable during connection while wallet-owned state is remounted. Tests cover account mismatch, malformed stored preferences, late profile responses and returning to a previously used wallet.

## Sync authorization v2

The wallet authorizes a generated device key for one service, wallet, authorization epoch and at most 24 hours. Each write is signed by that device over the ciphertext hash and expected data revision. Device keys stay in memory. Restarting requires re-enabling sync. Old v1 reusable wallet write signatures are rejected; clients must refresh. Existing encrypted blobs and the key-derivation message remain compatible.

Revoking this session creates a server-side denial record until its grant expires. Wallet-signed revoke-all advances a durable authorization epoch without deleting saved data. Every write checks both revocation mechanisms atomically with its data revision, so concurrent revocation cannot be bypassed by a delayed write. If a revocation request fails, the UI distinguishes locally stopped sync from confirmed server revocation.

Production must set `CHIRPY_SYNC_SERVICE_URL` to the canonical HTTPS `/api/usersync` URL. Preview deployments default to their immutable `VERCEL_URL`; open that exact deployment URL when testing sync. Native API-origin routing is implemented in PR #20; packaged-device acceptance remains pending.


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

Background refreshes retain the selected history page. Sending returns to the latest page; local reads/receipts do not advance while browsing older history. Switching chats invalidates delayed page results. Validation: 99 tests include a synthetic 100,000-message source, timestamp ties/floods, stale page responses and old-message reactions. Eight browser tests include a 2,000-message history, navigation, bounded rendering and desktop/mobile screenshots; two live XMTP dev-network tests pass. These are bounded pages rather than an unbounded scrolling DOM. Very large conversation rendering is now paginated; incremental inbox synchronization remains a follow-up.

## Supported gates and advisory posting policy

The production room editor offers mainnet token holdings, explicit ERC-1155 IDs, Safe owners and ENS. Role/power/delegate sources remain unavailable and are not presented as configured production controls. Send and reaction paths reject unsupported gates. Blank ENS inputs normalize to the documented primary-name rule.

Posting pauses and attachment rules are explicitly Chirpy-client policies. The current XMTP permission API governs membership, administrators and metadata, and provides no posting-permission update. Other clients can ignore a posting pause; no history revocation is promised. Reactions now obey the same gate/policy checks as sends. Super-admins are recognized for policy updates, and local policy changes only after the SDK confirms publication. Opt-in membership revalidation is implemented in PR #19; activation and an operator moderation/reporting process remain outstanding.

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

Admission uses one shared serial queue with at most 32 waiting operations. Waiting work expires after 10 seconds and overload returns 503 with Retry-After; the caller must obtain a fresh one-use challenge. An active native operation retains its slot until it finishes, so a timeout cannot accidentally create overlapping database writers. Registry policy is reloaded after queue admission and checked again immediately before membership addition; challenge expiry is also checked again. Tests cover saturation, expired waiting work, active-operation exclusion, recovery after failure, and policy removal/expiry during an in-flight eligibility read. Runtime dependency monitoring is implemented in PR #24; fleet-wide throttling remains pending.

## Membership lifecycle implementation

An opt-in internal worker now supports audit and enforcement using the shared gate client/queue. Confirmed nonholders require repeated observations at least five minutes apart; uncertain RPC/identity state preserves membership, administrators are exempt, and policy/identity changes reset removal evidence. Batches and observations are bounded. Maintenance is off until an operator configures and reviews it.

The synthetic XMTP dev drill passed actual wallet-to-inbox binding, eligible-member retention, audit-only outcomes, delayed SDK removal, and gatekeeper protection. Unit tests additionally cover RPC failures, multiple wallets, changed policy/bindings, admin promotion, lost authority, batch limits, shutdown and non-overlapping passes. Production activation, real on-chain multi-wallet acceptance, monitoring and the operator moderation/reporting process remain pending. Previously decrypted history is not revocable.

## Native sync routing

Packaged native apps require `VITE_API_ORIGIN` pointing at the hosted HTTPS origin. The release workflow defaults this to `https://chirpy.bittrees.org` and supports a repository variable override. Web builds retain same-origin routing when unset. Sync refuses credentials, paths in the configured origin, redirects and mismatched server authorization identities; requests omit cookies.

The server allows its canonical service origin plus explicitly configured `CHIRPY_SYNC_ALLOWED_ORIGINS`. Native release origins are `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost`; wildcard/null and unlisted origins are rejected. Preflight allows only GET/POST and Content-Type, with no credentialed CORS. Scoped wallet/device signatures remain required for mutations. See [Tauri's platform URL implementation](https://docs.rs/tauri/latest/src/tauri/manager/mod.rs.html) for the platform origin differences.

Endpoint and CORS tests cover native configuration, untrusted origins, invalid preflights, redirects, service-identity mismatch and signed versus unsigned writes. Native shell/device acceptance and signed/notarized distribution remain pending.

## Native dependency audit

The native lockfile updates plist to 1.10.1 (quick-xml 0.42.0) and anyhow to 1.0.104, clearing RUSTSEC-2026-0194, RUSTSEC-2026-0195 and the anyhow unsoundness warning RUSTSEC-2026-0190. The declared minimum Rust version is now 1.88, matching plist's requirement. CI audits the native lockfile with pinned cargo-audit 0.22.2 and retains its report; vulnerability advisories fail the job.

Seven warnings remain visible in `docs/security/native-baseline-2026-09-09.json`: six unmaintained transitive crates and the older glib safety advisory constrained by Tauri's GTK3/Linux dependency graph. They are not suppressed or represented as fixed. Upstream migration and platform applicability review remain release work, particularly for Linux. This audit covers Cargo dependencies, separately from npm and the gate container.

## Native shell hardening

The packaged shell now has an explicit content-security policy: bundled scripts plus WebAssembly, no JavaScript eval or injected inline scripts, bounded wallet verification frames, and no object embeds or external form submissions. HTTPS/WSS connections remain available for configured chain, XMTP, gate and wallet services. Development policy separately permits local dev connections. This follows [Tauri's CSP guidance](https://v2.tauri.app/security/csp/).

Desktop updater APIs are enabled only for a desktop target identified by Tauri's build environment; iOS/Android use store updates. Startup checks availability but does not silently install or restart over a conversation. Settings retains explicit installation/restart actions.

External gates can opt into the three standard Tauri origins through `GATE_NATIVE_ORIGINS`, alongside the existing web origin. Arbitrary/wildcard native origins are rejected, and native requests still require the same signed admission challenge. An operator must set this on the actual gate host.

Validation: 175 unit/HTTP tests pass, the browser attack probe blocks normal-page eval and inline injection while allowing chat and WASM, and both real XMTP dev tests pass with the native policy applied to served assets. The nightly XMTP flow now uses that policy. Packaged-device wallet return and store/signing acceptance remain outstanding.

## Release and nightly acceptance gates

Native release preparation now requires a matching `app-v` tag and consistent UI/Cargo/Tauri versions, production XMTP, a hosted HTTPS API, browser RPC and WalletConnect configuration, an updater signing key, and macOS signing/notarization inputs on the macOS runner. It checks web release readiness and requires dependency-aware gate health before building. Completed artifacts remain GitHub drafts for signature, installation, updater and platform acceptance; Windows code signing and final promotion remain operator work.

Configure repository variables `VITE_API_ORIGIN`, `VITE_MAINNET_RPC_URL`, `VITE_WALLETCONNECT_PROJECT_ID`, and `CHIRPY_GATE_HEALTH_URL`, plus the signing secrets described in the release workflow. The existing updater key has now been verified against the configured public key using a synthetic signed file and configured as the GitHub Actions signing secret. Apple signing/notarization credentials and released artifacts remain outstanding. Backend configuration and runtime readiness are still incomplete, so a production native release must currently remain blocked.

The nightly XMTP workflow no longer masks failures with continue-on-error. It runs the CSP-constrained browser flow plus real dev-network encrypted storage restoration and membership lifecycle drills, retains browser evidence and has a bounded timeout. These synthetic checks complement, rather than replace, operator backup restoration and production multi-wallet/device acceptance.

## Live gate readiness

The gate now warms and monitors its durable XMTP client, verifies super-admin authority over every registered room, and checks Ethereum chain ID plus recent block timestamps. Probes run serially without overlap, yield the shared queue between rooms, and expire healthy results after two minutes. A changed registry invalidates the previous result immediately. Startup, missing/empty registry, dependency failure, stale results and lost room authority return HTTP 503 with secret-free dependency status.

The local rollout proof now explicitly expects the synthetic gate to remain unready; fake configuration is no longer treated as live acceptance. Native release validation also rejects dev-network gates and confirms a live sync storage/authorization read. Container startup grace is extended to allow first initialization. Large registries must be load-tested against the freshness window; a slow probe cannot silently leave a healthy result indefinitely.

Validation includes wrong/stale chain data, failed or hung probes, recovery, registry changes, lost permissions, HTTP readiness transitions and the real XMTP dev room-authority drill with deterministic RPC responses. Production RPC, routing and operator alert delivery still require the configured gate host.

## Documentation reconciliation

Production, rollout/recovery, gate deployment, native release, README and roadmap instructions now reflect the external gate, encrypted persistent storage, sync v2, live readiness and draft release gates. Removed obsolete serverless gate and incomplete bare-container instructions. Operator decisions and device/production acceptance are explicitly distinguished from automated evidence.

## Per-conversation receipt preferences

Accepted DMs offer inherit/on/off receipt controls. The default inherits the global setting; overrides are scoped to wallet, transport, network and conversation, persist locally and travel only inside opted-in encrypted settings sync. Returning to inherit removes the override from the newer settings snapshot. Requests, blocked conversations, rooms and self notes expose no per-peer receipt control; transport consent checks remain authoritative.

Validation: 197 tests including real Redis checks, wallet/network isolation and override removal/merge coverage; the browser consent flow verifies reload persistence and blocked-control suppression. Type checks pass. Incoming peer receipt times are implemented in the next increment.

## Incoming receipt display

Accepted peer DMs show the latest peer receipt timestamp from the SDK lastReadTimes index. Enriched message queries omit receipt events, so the display uses the receipt-specific index and the actual peer inbox. Missing, unrelated, self, invalid or future evidence is suppressed; blocked/request/room views do not display receipts. The label explicitly avoids claiming that a particular message was read. Text/reply previews remain stable when receipts arrive.

Validation: the two-wallet XMTP dev flow under native CSP confirms no receipt before opt-in, then sends and reads a new message and verifies the actual receipt and retained preview. Opt-in does not retroactively acknowledge already-read messages. Unit coverage exercises consent, identity, malformed times and UI suppression.

## Room administrator controls

Room policy controls are shown only after the transport confirms administrator or super-admin authority. Missing/failed role checks hide them. During an advisory pause, administrators retain the same posting/reaction exception already applied by the transport; ordinary members cannot compose or react. Actions still recheck current SDK authority, so stale UI permissions cannot authorize a change. New local demo rooms model creator administration and role loss consistently. Labels say pause/resume member posting rather than implying protocol-wide freezing.

Validation: 209 tests and the browser create/pause/admin-post/role-loss flow pass, along with type checking.

## Bounded inbox rendering and SDK reads

Conversation lists render 50 rows per page and request ENS profiles only for visible rows. Search still covers every loaded conversation; query/filter changes reset the page and wallet/org/view changes reset list state. Per-conversation SDK mapping runs at most eight concurrent tasks, preserves order and drains active work after a failure before permitting a refresh retry.

Validation: 211 tests, a 10,000-conversation browser scenario with 50 initial profile lookups, and both live XMTP dev tests under native CSP pass. The SDK still synchronizes/lists the full inbox; this change bounds rendering and application-level concurrency, not total initial synchronization cost. Incremental SDK synchronization and real large-inbox device benchmarking remain follow-ups.

## Consumer migration review

Read-only inspection confirms both consumers still have Push room registries and separate wallet/UI adapters. INTEGRATION.md records the actual source revisions, history/authority decisions, staged adoption tests and rollback requirements. Their code, existing registries and Research draft branch remain unchanged. REMAINING-WORK.md consolidates the outstanding release dependencies and product follow-ups.

## Release service binding

Web readiness requires canonical HTTPS gate/sync endpoints and rejects development-network builds. Invalid endpoints are not echoed into public health output. Native release validation checks the canonical gate health path and requires its host/port to match the external gate reported by the web deployment, in addition to production network, fresh dependency readiness and live sync checks.

Validation: 230 tests, API type checking and rollout proof pass, including malformed/credential-bearing URLs, wrong hosts/ports and dev-network false positives.

## Pinned native release tooling

The Tauri CLI is pinned to 2.11.4 in the workspace lockfile. Local commands and the release action use that installed binary, and Apple validation checks its availability after a frozen install. Native documentation distinguishes Rust compilation from Xcode packaging and device acceptance.

The existing ignored updater private key signed a synthetic file whose Ed25519 signature verified against the configured public key. The matching private key is configured in GitHub Actions; the synthetic file was removed and no key material was committed. This verifies key compatibility, not a packaged release or updater installation.

## Local edits during asynchronous sync

Sync setup and remote merges now reject stale results when a newer local preference edit occurs during wallet authorization, remote reads, encryption, or write acknowledgments. Receipt opt-outs are preserved locally and setup reports that a retry is needed. Local edit timestamps advance monotonically even when the clock repeats or moves backwards.

Regression tests delay authorization, a remote read and a write acknowledgment while changing both receipt preferences. All three fail against the previous implementation and pass with the guard. This addresses a same-device race; extended real-device offline/conflict acceptance and legacy deletion semantics remain outstanding.

## Validated language preferences and document language

Stored or runtime language values must be registered dictionary keys. Prototype names such as constructor and __proto__ no longer enter the translation state and crash rendering. Language changes also update the document language so assistive technologies receive the correct pronunciation language.

Five regression cases cover malformed/prototype values, supported persisted Spanish, runtime rejection, persistence and document-language updates. They fail against the previous implementation. Broader translation coverage and assistive-technology acceptance remain outstanding.

## Settings translation coverage

Settings and the native update card now translate their controls, privacy/revocation explanations, organization metadata, ENS results and known sync status messages into Spanish. Names, addresses, release notes and unknown provider diagnostics remain literal text. ENS wording no longer equates an unresolved name with an available registration. Template interpolation preserves literal values and rejects inherited dictionary keys.

Catalog tests require matching English/Spanish keys and placeholders. The browser flow verifies Spanish sync activation/revocation results, persisted language after reload, privacy controls, ENS validation, switching back to English and a 390-pixel viewport without horizontal page overflow. Dialogs and other application surfaces still need broader translation coverage; this does not establish full localization or assistive-technology acceptance.

## Organization import validation

Organization imports validate nested branding, chain, gating rules, policy, room seeds, roles and administrators before entering application state. Invalid present fields are rejected; absent legacy collections, branding slugs, gating defaults and policies are normalized. Imports reject the reserved Personal organization ID, duplicate seed IDs, oversized collections and files above 256 KB UTF-8. Error output is bounded. This schema validation does not certify gate authority, deployment URLs, contract presets or production support for additional rule types.

Twenty-nine regression cases cover malformed render inputs, rule/policy values, legacy normalization, preset round trips and resource limits. The browser test rejects malformed roles without changing stored organizations, then imports a legacy config and verifies Settings after reload without page errors. Dialog localization and recovery from previously corrupted local storage remain follow-ups.

## Saved organization recovery

Startup validates saved organizations before rendering. Valid entries remain available; malformed entries, duplicate IDs and malformed store roots are retained as original snapshots downloadable from Settings. An invalid active organization falls back to Personal. The version-2 local store carries validated organizations and recovery snapshots; the legacy version-1 key remains untouched for recovery/rollback. Subsequent old-client writes to the legacy key are not merged into the version-2 store.

Storage read failures prevent overwriting unread data. Write failures are surfaced in Settings while in-memory data remains available. Organization creation now uses the same validation boundary as imports and reports errors in its dialog. Tests cover read/quota failures, mixed/corrupt stores, stable snapshot retention, downloads, reload recovery and invalid-then-valid creation. Recovery snapshots are retained locally until the user clears browser data; they are not uploaded by this feature.

## Dialog translations and gate-field accessibility

Chat, room, policy, gate-rule and organization creation/import dialogs now provide Spanish controls and explanations. Import syntax/schema failures are localized while preserving technical field names and unknown provider diagnostics. Gate fields have explicit accessible names and numbered groups; rule rows wrap on narrow screens so token standards remain readable. Preset and gate-service hints distinguish illustrative configuration from production setup.

The Spanish browser flow creates a DM and room, edits/removes an ERC-1155 rule using accessible labels, checks a mobile dialog, rejects malformed JSON and an invalid organization chain, then successfully creates an organization. Catalog/placeholder checks and existing English flows remain regression coverage. Broader operational pages, transport diagnostics and real assistive-technology acceptance remain follow-ups.

## Chat locale and known transport feedback

Conversation-list/message timestamps and incoming receipt display follow the selected interface language. Room member counts, access state, policy summaries, navigation labels and creation tooltips are translated. Known admission, consent, messaging and policy failures use the Spanish catalog; unknown provider diagnostics remain unchanged.

Formatting tests cover selected-language times/dates and invalid timestamps. The Spanish browser flow now verifies rendered message/list times, the room member/access/policy summary and mobile navigation labeling. This covers the main chat interface; operational pages and vendor-specific diagnostic localization remain outside this increment.

## Unsigned iOS simulator packaging

Apple CI now generates the Xcode project and builds an unsigned simulator archive with the pinned Tauri CLI. Packaged bundle identity, simulator platform, executable and the `chirpy` return scheme are checked before installation. An isolated iPhone simulator installs and launches the app, requests its registered return URL, and retains launch and URL-confirmation screenshots for visual review. iOS may present an Open confirmation; URL dispatch alone does not prove completed handoff.

This checks packaging and initial launch with XMTP dev and an inert API origin. It does not establish wallet handoff, authenticated messaging, persistent WKWebView storage, signing, TestFlight or physical-device acceptance. Production release artifacts still require the separate signed release workflow and service readiness gates.

## Organization collection capacity

Creation/import rejects a new organization before the saved collection exceeds the 1,000-entry reload limit. Replacing an existing organization remains possible at capacity, and removal immediately frees a slot. The same collection reference is updated before React renders, preventing multiple additions in one event from bypassing the limit. Limit errors are available in English and Spanish.

The provider regression fails against the prior implementation and verifies back-to-back additions, replacement, removal, slot reuse and a reload with all 1,000 entries intact and no recovery quarantine. Existing malformed-store and read/write failure coverage remains in place.

Extended acceptance was rerun on main `75ecae90da4fd2b6ddef7a9571e0bbfbdd4011ea`: [run 34357787147](https://github.com/Bittrees-Technology/chirpy/actions/runs/34357787147) passed both live XMTP dev browser tests under native CSP, encrypted fresh-volume restore with installation/message continuity and wrong-key rejection, and the membership audit/enforcement drill. The membership drill uses deterministic RPC/balance responses; production on-chain and operator acceptance remain outstanding.

## Native warning platform review

[Target-specific dependency evidence](security/NATIVE-DEPENDENCIES.md) identifies `glib` and `proc-macro-error` in the checked Linux graph and absent from the checked macOS ARM64, iOS ARM64 simulator and Windows x64 graphs. All five unmaintained Unicode crates remain present on every checked target through URL-pattern/Tauri utilities. The review records the lockfile digest, scope, reproduction method and upstream follow-ups. It establishes dependency presence, not exploitability or release approval; all seven audit warnings remain unsuppressed.

## Spanish support and security instructions

The public support and security pages now have Spanish versions with reciprocal language links, document-language metadata and dedicated deployment routes. Public bug reports still go to the existing GitHub issue template; security findings still go to the private advisory flow. Preview limitations, account requirements, sensitive-data guidance and the absence of guaranteed response times are preserved. This translation does not establish approved privacy/terms or new operator commitments.

Four browser scenarios verify the existing English pages and Spanish mobile pages, language navigation, keyboard focus, reporting URLs and no horizontal overflow. Both Spanish pages were visually inspected. Production routing is verified separately after deployment.

## Posting restrictions during directory refresh

A published room's directory entry supplies its trusted admission gate while the joined group's current posting policy remains authoritative for Chirpy's send/reaction checks. Refreshing the directory no longer replaces a paused group's policy with the directory's organization defaults. The room card uses the same directory gate as the transport.

Known room restrictions remain available during asynchronous inbox mapping and after a failed metadata refresh. Metadata for conversations no longer present in either the inbox or directory is pruned after a successful refresh. Regression tests reproduce both the directory override and an actual unintended synthetic send during the former metadata-clear window; the fixed code rejects member sends/reactions and retains restrictions on refresh failure. This strengthens Chirpy's advisory client policy, not protocol-wide enforcement against other clients.

## Incremental streamed inbox refresh

Healthy message streams and local send, reaction, read, consent and room-policy changes invalidate the affected conversation summaries. Incremental refresh reads the SDK's local conversation list and remaps only new or invalidated entries; it does not repeat network-wide synchronization. Removed local records are pruned from the summary cache. New invalidations arriving during an asynchronous refresh remain queued for the next pass.

Initial load, the existing ten-second visible polling interval, focus/online/visibility recovery, room admission, stream errors/retries and failed mapping still require full reconciliation. Unsubscribing disables the incremental path. This preserves the recovery interval while reducing work from streamed bursts; initial and periodic full synchronization, local full-list enumeration/sorting and real-device large-inbox benchmarks remain unfinished.

A 10,000-conversation regression remaps one entry for one streamed update; the previous implementation remaps all 10,000. Further tests cover cache pruning, concurrent invalidations, failures/reconnect, focus/online recovery, consent, local reads, sends and reactions. These are operation-count assertions, not a measured real-device latency claim. Existing paused-room refresh regressions remain in the suite.

## Native validation covers shared packages

Apple validation now runs when shared core/transport packages or root TypeScript/test configuration change, in addition to the web/native directory and dependency manifests. Those shared packages are bundled into the native frontend; excluding them could leave a native build untested after a messaging change. The workflow change itself exercises macOS compilation and the generated iOS simulator archive/launch path against the current shared code.

## Untrusted room metadata validation

Received Chirpy room metadata validates its version, namespace, description, gate and policy before entering conversation state. Encoded gates decode strictly; damaged data cannot silently become an open gate. The metadata envelope is limited to 64 KiB UTF-8 and a structured room description to 10,000 characters. Valid legacy plain descriptions, omitted legacy defaults, and supported object/encoded gates remain readable. Unsupported production gate types and malformed structured metadata are marked unavailable for room actions.

Invalid configuration yields a safe read-only policy and a repair message in English/Spanish. The UI disables composition, reactions and policy/join controls; transport checks reject writes even for administrators. Directory metadata cannot erase the error. Creation and policy updates use the same validation before writing network metadata, avoiding newly created rooms that fail their own read validation. This does not grant a client authority to repair an unknown gate or weaken protocol membership.

Regressions cover nested malformed values, corrupt encoding, unknown versions, unsupported gates, resource bounds, directory overlays, writer validation and the repair UI. An integrated case reproduces an unintended synthetic send through the previous damaged-gate fallback and rejects it with the new boundary.
