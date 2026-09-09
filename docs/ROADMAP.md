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

## Production acceptance remaining

1. Deploy a gate with reviewed identity/registry, production RPC/storage and matching web/org configuration; prove allowed/denied admission and restart behavior.
2. Configure alerts, backups/key custody, operator restore and moderation/retention ownership; review audit mode before enforcement.
3. Supply signing credentials; pass desktop installation/updater, Windows signing, iOS wallet return and TestFlight acceptance. Review outstanding native/container advisories.
4. Publish approved privacy/terms and finalize brand artwork.

## Product and integration follow-ups

- Incoming receipt times and per-chat outgoing overrides are implemented; retain device acceptance coverage.
- Reduce initial/periodic full synchronization and local full-list enumeration costs, and complete real-device large-inbox benchmarks. Streamed updates refresh affected summaries; rendering/profile work and SDK mapping concurrency are bounded.
- Broader translations and mobile/accessibility acceptance (room administrator controls are implemented).
- Trusted role/power/delegate/multi-chain resolvers and verified presets where needed.
- Long-running multi-device sync/conflict acceptance and explicit deletion/unblock merge semantics.
- Shared UI/embed packaging and Governance/Research migration with rollback tests; framing requires an intentional origin allowlist.
- Shared abuse limits where deployment topology needs them.

## Later

Voice, presence/SSE and optional organization relays follow core acceptance. Protocol-wide posting freezes need a supported enforcement mechanism; current client policies cannot provide one.
