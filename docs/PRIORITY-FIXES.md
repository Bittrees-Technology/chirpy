# Priority fixes — September 2026

## Implemented

- The external gate reads an operator-controlled room registry. Requester-supplied gates, organization rules, and destination overrides cannot affect admission.
- Each room join uses a random, expiring, single-use challenge binding service URL, namespace, room, wallet, and inbox. The gate checks the authoritative XMTP wallet-to-inbox association before adding a member. Restarts invalidate outstanding challenges; one process owns the gatekeeper database and serializes admission operations.
- Production rules fail closed on malformed, zero/negative, or unsupported gates. Supported rules are mainnet ERC-20/721, ERC-1155 with an explicit token ID, Safe owners, and ENS. Role, power, delegate, and other-chain resolvers need separate implementation.
- Rooms are filtered by exact namespace; matching names do not merge independent rooms. DMs remain wallet-global. Legacy rooms without a namespace remain available under Personal. New organizations with matching names get distinct namespaces.
- XMTP no longer automatically creates default rooms separately for each wallet. The gate's published catalog provides stable room IDs to nonmembers, with a working join path. Catalog rooms are not assumed to include the current wallet.
- Read-receipt preference is enforced by the provider and transport. Receipts require explicit opt-in on each transport call; mock local read accounting is unchanged.
- Drafts survive send failure and conversation switches. Failed sends have an error and can be retried; successful sends clear only the submitted draft. Concurrent duplicate submissions are blocked.
- Sync replacement uses atomic Redis revision comparison and increment, not GET/check/SET. Storage outages and decryption failures cannot masquerade as missing records. Conflicts require a pull/merge/retry; write failures do not claim successful activation.
- Stale conversation/message loads are ignored after switching wallet, organization, or conversation. New gated room creation gives a visible configuration error if the external gate or bot identity is absent.
- Gate container includes the previously missing ops-utils module, limits request-body size, and checks registry readability/validity in health responses.

## External gate setup

The production web configuration inspected on 9 September has XMTP and KV sync configured, but no external gate URL or browser gatekeeper address. There is no authenticated gate-host CLI in this checkout. A hosting account/service and gatekeeper identity still need to be supplied and verified; merging code does not provision these dependencies.

On the **external gate host**, configure:

- `XMTP_GATEKEEPER_PRIVATE_KEY`: existing gatekeeper wallet key, in secret storage.
- `MAINNET_RPC_URL`: server-side mainnet RPC.
- `GATE_PUBLIC_URL`: canonical HTTPS endpoint, such as `https://gate.example.org/api/room-join`.
- `CHIRPY_GATE_ROOMS_FILE`: absolute path to an operator-owned registry, typically `/data/rooms.json`.
- `GATE_ALLOW_ORIGIN`: Chirpy's exact web origin.
- `GATE_DATA_DIR`: durable XMTP store, typically `/data`.

Do not share the XMTP database between multiple gate processes. Challenges live in bounded process memory and expire after five minutes. Use one active instance; a failover asks users to request a fresh challenge.

The registry is a JSON array. `selfhost/rooms.example.json` is deliberately empty; it grants no access. Add real, existing room IDs with reviewed gates. Example shape (replace the ID/namespace and choose the actual rule):

```json
[
  {
    "id": "ACTUAL_XMTP_CONVERSATION_ID",
    "namespace": "EXACT_IMPORTED_ORG_NAMESPACE",
    "title": "Members",
    "chainId": 1,
    "gate": { "combine": "all", "rules": [{ "kind": "ens" }] }
  }
]
```

Registry rules must include any required organization membership conditions; imported browser config is not an authority source. The registry publishes room IDs, titles, namespaces, and gates. Only list rooms whose discovery metadata should be public. Keep the file read-only to clients and write it atomically when updating. Unsupported/malformed entries reject the entire registry instead of partially enabling access.

The gatekeeper must already be a super-admin of every registered room. Create the room once, then publish that ID. The UI shows gated room IDs for the operator. Room creation does not automatically enroll a room in the trusted registry.

On the **web deployment**, set `VITE_GATEKEEPER_ADDRESS` to the corresponding public address and `CHIRPY_EXTERNAL_GATE_URL` to the canonical endpoint. Each imported production organization must have its matching `gateUrl`. These are separate settings: health metadata does not rewrite organization configs.

Deploy the gate with its persistent volume and registry, check `/health`, then refresh the web build/config. Prove a qualifying wallet joins the same room a nonqualifying wallet is denied. Test a substituted inbox, a replayed challenge, and a gate restart. The local rollout proof checks configuration/wrapper behavior only, not actual production wallet admission or live dependencies.

## Compatibility and recovery

- v1 unscoped join signatures are intentionally rejected; refresh older clients before joining.
- Sync records gain a server-owned `revision`; existing records begin at revision 0 and are upgraded on the first successful write. There is no destructive datastore migration.
- Older clients lacking `expectedRevision` receive 409 instead of overwriting data. Refresh/reopen Chirpy. The encrypted payload/key format is unchanged.
- Do not roll back the sync API to a version that lacks atomic revision checks while new clients are active. Keep client and API versions together.
- Gate privacy and receipt fixes cannot withdraw old receipts or already decrypted room history.

## Remaining work

1. Provision/verify the external gate host, bot identity, reviewed room registry, and matching web/org configuration; run real multi-wallet and multi-device production acceptance.
2. Enforceable room freeze/moderation, membership revalidation/removal, and clear treatment of restrictions other XMTP clients can bypass.
3. Actual unread counts; accept/reject requests; transport-backed blocking/reporting; receipt display and optional per-chat overrides.
4. Trusted role, voting-power, Safe delegate, and multi-chain resolvers; verified preset contract addresses; broader ERC-1155 discovery if needed.
5. Paginated/virtualized history, bounded incremental refresh, stable scroll position, accessible icon labels, and complete EN/ES strings.
6. Revocable/scoped sync device authorization, wallet-specific settings isolation, long-running sync recovery/merge testing, and defined unblock/delete conflict semantics. Current sync write signatures remain the existing v1 authorization format.
7. Genuine support/security/privacy/terms artifacts and moderation/data-retention processes. The existing public-surface PR is included; it does not invent these policies.
8. Successful signed desktop releases, notarization, download/install/updater verification; iOS project generation, real-device wallet/deep-link/store validation, and TestFlight acceptance.
9. Shared UI/embed packaging and replacing duplicated chat code in Governance and Research, with migration/rollback tests.
10. Live dependency probes, readiness alerts, shared abuse limits, backup/restore drills, and operational ownership. Health remains configuration-focused apart from registry validation.
11. Release-blocking real gated-room tests, expanded accessibility/mobile acceptance, and dependency audit remediation. The existing XMTP nightly remains advisory.
12. Final brand artwork and remaining roadmap/README reconciliation.
13. Later roadmap: voice calls, presence/SSE, and optional organization relays.
