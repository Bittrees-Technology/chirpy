# Governance and Research integration acceptance

This is the migration contract for the remaining integration work. No consumer cutover, package publication or iframe authorization has been performed. The early [PLAN.md](PLAN.md) is historical; its proposed package names and claim of automatic cross-protocol history continuity are not an implemented contract.

## Inspected consumer state

The 9 September 2026 read-only inspection covered local Governance commit `87ec28310ed24e884e52f99cd21849ae3d64b576` and Research commit `af10bb37b9b0224fc89f403b0f1633eab0f46671`. Research was on `codex/draft-capital-sync-api-2026-08-06`; preserve that branch and use an isolated migration checkout when implementation begins.

| Area | Existing consumers | Chirpy | Cutover requirement |
|---|---|---|---|
| Wallet integration | wagmi/RainbowKit account and wallet client | Injected or WalletConnect provider owned by Chirpy | An explicit signer adapter with wallet-switch/disconnect isolation; no private-key or reusable-signature transfer |
| Direct messages | Browser SDK 7 hooks and consumer-specific UI models | Browser SDK 7 transport, consent, unread cursors and receipt index | Verify inbox identity, installation/storage ownership and the supported history-sync path on each origin |
| Community rooms | Push SDK, `/api/rooms`, built-in/custom room IDs and proposals | XMTP groups and an operator-controlled external gate registry | Decide preservation/archive versus historical migration; map real room IDs and memberships explicitly |
| Membership policy | Consumer role/power rules and registries | Supported mainnet token/Safe-owner/ENS rules; role/power/delegate rules disabled | Reviewed authoritative resolvers or an explicitly approved supported policy; never substitute a weaker rule |
| Sync/settings | Consumer-local preference and saved-message formats | Wallet-isolated encrypted snapshot with revocable v2 device grants | Field mapping, consent defaults, conflict/deletion semantics and canonical service identity |
| Embedding | Host app routes | Standalone app; framing denied by default | A shared UI/package boundary or an explicitly allowed iframe origin, tested with wallet/storage behavior |

Push room IDs and history are not XMTP group IDs/history. Sharing a wallet does not migrate those records. Chirpy's encrypted settings endpoint also does not transfer the native/browser XMTP database. Keep existing history and registries intact until the selected migration path passes acceptance.

## Implementation sequence after policy/history decisions

1. Extract a versioned shared UI and transport adapter with explicit configuration/signing interfaces. Preserve consent checks, namespace isolation, bounded history and wallet-switch cancellation. Build a separate consumer fixture against the packed artifact before publication.
2. Add an opt-in Research route in an isolated checkout, pinned to the reviewed package version. Keep the existing messaging route and its data available. Do not delete old libraries or API handlers during this step.
3. Validate the chosen historical-room path, trusted gate registry, qualifying/denied wallets, original inbox identity, consent/receipts, encrypted sync and multi-device behavior. Record exact source/package/deployment versions and test identities.
4. Repeat the accepted route migration in Governance. Enable cutover only after each consumer's acceptance and rollback record is complete; remove duplicate code only after confirming it has no remaining callers.
5. For iframe use, configure exact reviewed parent origins on an isolated embed surface. Test rejected parents, nested frames, wallet return, storage isolation and strict message origin/source/schema validation. The standalone frame restriction remains intact. No wallet key, session key or arbitrary-signing bridge belongs in postMessage.

## Rollback and ownership

Rollback restores the prior consumer route/package while preserving both systems' data. It cannot undo protocol membership changes, issued receipts, sync epochs or already decrypted messages. Keep the old deployment, room-ID mapping and registry snapshot with the release evidence. Assign the operator responsible for history retention, moderation, role authority and the cutover decision before migration.

The unresolved decisions are the historical-room strategy, authoritative membership sources, intended embed origins and adoption owner. Until supplied, the integration remains pending; the consumers have not been modified by this hardening run.
