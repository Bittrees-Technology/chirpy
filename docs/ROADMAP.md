# Roadmap

The [production readiness ledger](PRODUCTION-READINESS.md) records implementation and test evidence. Source completion and production acceptance are separate.

## Implemented

- XMTP DMs/scoped rooms, wallet/ENS login, consent/blocking and precise unread cursors.
- Trusted external registry, one-use signed admission, bounded queue and supported fail-closed rules.
- Opt-in membership audit/enforcement with repeated evidence and administrator protection.
- Wallet-isolated preferences, expiring/revocable sync grants and atomic writes.
- Bounded refresh/history, keyboard/focus improvements and EN/ES chat controls.
- Restricted encrypted-storage container, dependency readiness and synthetic restore/membership drills.
- Dependency audits, native CSP/API routing, draft-only release preparation and signing/service preflight.
- Public support and security reporting paths.
- Chat branding and dual-domain serving with preserved compatibility identifiers.
- Reviewed encrypted application-data recovery and user-controlled public/private profile labels.
- Original-protocol Push room integration, bounded history/membership, text/file/reply composition (up to six files per standalone message) and explicit PNG/JPEG previews and native add-only reactions.
- Connected Mail inbox/conversations, scoped duration choices, read/send/reply, formatted previews and bounded attachments.
- Disabled wallet↔email bridge authority, queues, source/sender workers, health and recovery foundations.

## Production acceptance remaining

1. Deploy a gate with reviewed identity/registry, production RPC/storage and matching web/org configuration; prove allowed/denied admission and restart behavior.
2. Configure alerts, backups/key custody, operator restore and moderation/retention ownership; review audit mode before enforcement.
3. Supply signing credentials; pass desktop installation/updater, Windows signing, iOS wallet return and TestFlight acceptance. Review outstanding native/container advisories.
4. Publish approved privacy/terms and finalize brand artwork.
5. Deploy Wallet verification and live bridge identities/credentials, enroll approved routes and verify delivery/revocation/recovery in both directions. Connected Mail pilot acceptance does not enable forwarding.
6. Complete source-room, cross-origin history/recovery, Research alignment and device acceptance before consumer cutover, Chirpy forwarding and GitHub/Vercel renaming.

## Product and integration follow-ups

- Incoming receipt times and per-chat outgoing overrides are implemented; retain device acceptance coverage.
- Reduce initial/periodic full synchronization and local full-list enumeration costs, and complete real-device large-inbox benchmarks. Streamed updates read and refresh affected SDK records directly in bounded batches; rendering/profile work and SDK mapping concurrency are bounded. Initial and periodic full enumeration remains.
- Broader translations and mobile/accessibility acceptance (room administrator controls are implemented).
- Trusted role/power/delegate/multi-chain resolvers and verified presets where needed.
- Long-running multi-device sync/conflict acceptance and explicit deletion/unblock merge semantics.
- Complete remaining Push media/composite parity, larger Mail attachments and source integration acceptance with rollback tests. Shared UI/embed packaging is optional later work; framing requires an intentional origin allowlist.
- Shared abuse limits where deployment topology needs them.

## Later

Voice, presence/SSE and optional organization relays follow core acceptance. Protocol-wide posting freezes need a supported enforcement mechanism; current client policies cannot provide one.
