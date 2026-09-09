# Remaining work after the September hardening increments

Use [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) for completed work and evidence. This list consolidates unfinished items from the review. Passing source checks does not establish production service, device or operator acceptance.

## Production release dependencies

1. **Gate host and identity:** choose/provision the host and TLS domain, persistent production wallet/database keys, key custody, production RPC, reviewed nonempty registry and bot super-admin roles. Set matching browser, web-health and organization routing values; opt into native origins where required.
2. **Real admission acceptance:** qualifying and denied wallets against actual on-chain rules, inbox substitution/replay rejection, restart continuity, multi-wallet binding and multiple devices. Synthetic dev-network drills do not replace this.
3. **Operations:** backup scheduling, independently controlled key backups, operator restore and measured recovery targets; alert destinations, incident owner and escalation process. Review membership audit outcomes before enforcement. Complete a moderation/reporting process and any required shared abuse controls.
4. **Public policies:** identify the operator, actual retention/deletion rules and contacts, then publish approved privacy/terms. Support/security paths exist; no invented legal entity, retention period or response-time promise should fill this gap.
5. **Native distribution:** supply Apple/platform signing credentials and repository variables (the updater key is verified and configured); verify signed/notarized macOS and Windows signing, downloaded artifact signatures, clean install and updater behavior. Complete Xcode project generation/packaging and iOS real-device storage/wallet-return/deep-link and TestFlight acceptance. Prepared artifacts remain drafts.
6. **Dependency follow-up:** review the seven native warnings, especially the Linux GTK/glib constraint, and the 20 unfixed medium/low container findings. Track upstream fixes and platform applicability; no warning suppression or certification is implied by the audit gates.

## Product and integration completion

7. **Multi-device longevity:** extended offline/reconnect/conflict/revocation testing on real devices, and explicit deletion/unblock merge semantics for legacy preference/saved-message data. Current XMTP blocking uses conversation consent, not the legacy blocked-address preference array.
8. **Scale and accessibility:** incremental SDK inbox synchronization, real-device large-inbox benchmarks and wider mobile/assistive-technology acceptance. Rendering/history/profile work and application-level concurrency are bounded; the SDK still synchronizes the complete inbox. Finish remaining translation coverage.
9. **Governance/Research/shared UI/embed:** implement the migration contract in [INTEGRATION.md](INTEGRATION.md) after history, authority and embedding decisions. Existing Push rooms/history and the Research draft branch remain intact. No shared UI package or consumer cutover has been shipped.
10. **Additional resolvers and presets:** trusted role, voting-power, Safe-delegate and other-chain sources; verified real preset contracts and broader ERC-1155 discovery if required. Unsupported production rules remain disabled. Protocol-wide posting freezes require an enforcement mechanism beyond the current advisory client policy.
11. **Artwork:** replace interim icons with approved final brand assets and verify native/export sizes.

## Later expansion

Voice calls, presence/SSE and optional organization relays follow core release acceptance. They are not implemented by the security hardening increments.
