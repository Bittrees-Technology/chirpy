# Linked-wallet display choices

The signed storage protocol is implemented. Settings controls, current-link SDK resolution, and actual multi-wallet browser acceptance remain required before claiming the user-facing feature complete. Existing public-name records and their signature/replay boundaries remain unchanged.

## Protocol

`/api/profile?kind=display-wallet` uses the existing profile deployment, canonical service identity, CORS configuration and storage credentials. GET additionally requires `network=dev|production` and a comma-separated `wallet` list of 1–50 unique lower-case Ethereum addresses. POST accepts only `{command,signature}`. It is disabled in nonproduction Vercel deployments, like public names; local tests provide explicit service configuration.

Commands bind version, canonical service (including the kind query), signing wallet, XMTP network, inbox ID, desired display wallet (or null for automatic selection), current revision and an expiry of at most five minutes. EOAs and Ethereum-mainnet contract signatures use the existing signature verification model. Display signatures cannot publish names or authorize messages, transactions, mailbox access, wallet linking or room membership.

Each wallet owns one independent record per network. Redis atomically checks the exact previous record and its own clock, advances the revision and stamps the commit time. Automatic selection retains a permanent revision and inbox-scoped reset, preventing replay of an earlier selection. It removes the prior display-wallet value, not the already-public signing-wallet/inbox association. No signature or older choices are retained. Corrupt or unknown stored data is preserved and fails closed.

## Required recipient validation

Storage proves which wallet signed a preference; it does **not** certify the claimed inbox association. The recipient must obtain the current linked-wallet set from trusted XMTP SDK state, fetch a complete bounded set of records for those wallets and apply `selectDisplayWallet`. Do not accept a wallet list supplied by the profile service or use the selected display identity as messaging or membership authority.

The selector accepts only current linked authors, the current network and inbox, and a display wallet still present in that linked set. The newest committed intent wins; lexicographic wallet order breaks same-millisecond ties deterministically. A newer automatic reset or an unlinked target falls back to automatic selection instead of reviving an older choice. Missing, duplicated, invalid or mixed-network responses also fall back to automatic selection. After a signer is unlinked, its record no longer participates.

## Remaining client work

- Add explicit public-choice consent, wallet signing, linked-wallet selection and automatic reset in Settings; preview the chosen wallet's independent public profile.
- Bound and expire recipient lookups, revalidate unlinking, and avoid retaining a selected wallet in the legacy permanent DM peer cache.
- Preserve inbox-based reply/reaction/room authority and local self-message detection.
- Verify cross-device refresh, account/network changes, withdrawal, competing linked-wallet choices, partial responses and actual XMTP multi-wallet association/removal with disposable identities.
