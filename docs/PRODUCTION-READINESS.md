# Production readiness execution ledger

We implement and merge independent changes in increasing complexity, while preserving dependency order. A merged implementation is not evidence that an external deployment or device acceptance test has passed.

| Order | Increment | Status / completion evidence |
|---|---|---|
| 1 | HTTP hardening: size/time limits, proxy trust, CORS, sanitized errors, security headers, real HTTP regression tests | Merged in PR #3; 63 tests, type checks, build and rollout proof pass |
| 2 | Keyboard accessibility, message scrolling, translated chat controls | Implemented; native-dialog and message-history regression tests in this PR |
| 3 | Unread counts, request acceptance/rejection, blocking and receipts | Pending |
| 4 | Wallet-specific preferences and revocable sync authorization | Pending |
| 5 | Pagination, bounded refresh, long-history performance | Pending |
| 6 | Trusted gate resolvers and protocol-enforceable moderation/membership lifecycle | Pending |
| 7 | Dependency remediation, live probes, backup/restore and release acceptance | Pending |
| 8 | Production gate deployment and multi-wallet acceptance | Needs hosting/bot identity and reviewed room registry |
| 9 | Public support/security/privacy/terms material | Needs actual operator/contact/retention decisions |
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
