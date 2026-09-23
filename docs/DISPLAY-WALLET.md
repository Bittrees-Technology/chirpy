# Linked-wallet display choices

Settings offers an explicit public choice among wallets currently linked to the active XMTP inbox, or an automatic reset. Public consent and a wallet signature are required. The selected wallet’s independently published public profile is previewed; existing public-name records and their signature/replay boundaries remain unchanged.

## Protocol

`/api/profile?kind=display-wallet` uses the existing profile deployment, canonical service identity, CORS configuration and storage credentials. GET additionally requires `network=dev|production` and a comma-separated `wallet` list of 1–50 unique lower-case Ethereum addresses. POST accepts only `{command,signature}`. It is disabled in nonproduction Vercel deployments, like public names; local tests provide explicit service configuration.

Commands bind version, canonical service (including the kind query), signing wallet, XMTP network, inbox ID, desired display wallet (or null for automatic selection), current revision and an expiry of at most five minutes. EOAs and Ethereum-mainnet contract signatures use the existing signature verification model. Display signatures cannot publish names or authorize messages, transactions, mailbox access, wallet linking or room membership.

Each wallet owns one independent record per network. Redis atomically checks the exact previous record and its own clock, advances the revision and stamps the commit time. Automatic selection retains a permanent revision and inbox-scoped reset, preventing replay of an earlier selection. It removes the prior display-wallet value, not the already-public signing-wallet/inbox association. No signature or older choices are retained. Corrupt or unknown stored data is preserved and fails closed.

## Required recipient validation

Storage proves which wallet signed a preference; it does **not** certify the claimed inbox association. The recipient must obtain the current linked-wallet set from trusted XMTP SDK state, fetch a complete bounded set of records for those wallets and apply `selectDisplayWallet`. Do not accept a wallet list supplied by the profile service or use the selected display identity as messaging or membership authority.

The selector accepts only current linked authors, the current network and inbox, and a display wallet still present in that linked set. The newest committed intent wins; lexicographic wallet order breaks same-millisecond ties deterministically. A newer automatic reset or an unlinked target falls back to automatic selection instead of reviving an older choice. Missing, duplicated, invalid or mixed-network responses also fall back to automatic selection. After a signer is unlinked, its record no longer participates.

## Client behavior and acceptance

The editor rechecks the active provider, account and fresh SDK wallet links before and after signing. Interrupted or mismatched acknowledgements require reload; a saved response is followed by another read of the shared winning choice. Changing the account/provider unmounts and cancels the editor. Automatic reset retains the public inbox association described above.

Recipient choices use memory-only per-client caches, 50-wallet batches, at most four concurrent requests and 2,500 queued/cached wallets. Successful reads expire after30seconds; failed reads after5seconds. A2second display deadline retains the underlying network slot, preventing repeated polling from multiplying slow requests. Missing choices use the SDK-verified automatic identity. Identity resolution retains its own bounded30second cache; inbox reconciliation and focus refresh pick up changes, so this is eventual display consistency, not an instantaneous unlink guarantee.

Selected display identities never populate the legacy persistent DM peer cache. DM titles, non-self message authors, reactions and room roster labels resolve through current SDK inbox membership. Message routing, original reaction inbox IDs, room roles and local self-message classification keep their existing authority. An explicit display refresh invalidates in-flight lookups.

Hardening covers account/provider changes during signing, partial/foreign/mixed-network responses, stale completion, cache/concurrency limits, competing choices, removed targets/signers, explicit consent and StrictMode remounts. The disposable XMTP-dev browser scenario exercises actual wallet association/removal, a signed synthetic profile-service fixture, DM/reply delivery, group author/roster display, a linked-wallet installation, reset and fallback after unlink. Actual Redis tests verify the storage contract separately; the fixture is not production publication evidence.

Remaining release acceptance: real production-origin multi-wallet use and physical-device/offline longevity. Push identities continue to follow their existing protocol and are not changed by this XMTP display setting.
