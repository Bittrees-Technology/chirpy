# Public names in Chat

Settings separates the device-local label from an explicit public profile choice.
A connected wallet can publish a custom name or withdraw it and choose its wallet
address. Nothing is published on connection, typing or ENS resolution. The user
reviews the name/address and checks consent before a purpose-specific signature.
Only a name and public wallet identity are published; Mail addresses, verified
bindings, room membership and other private settings are not inferred or exported.
Names are not unique and do not verify a real-world identity.

`/api/profile` retains the canonical API origin configured by
`CHIRPY_SYNC_SERVICE_URL`, using a new `/api/profile` signature service and a
separate `chat:profiles:v1:<service-hash>:<wallet>` Redis namespace. It uses existing
KV credentials and exact sync/migration CORS origins; no new service identity or
secret is required. Preview deployments are disabled. Public GET accepts at most
50 unique wallet addresses per request, with no enumeration endpoint. Responses
are no-store. Existing per-process rate limits apply; fleet-wide abuse controls
and public policy/retention review remain launch work.

Each publication signature binds version, service, wallet, current revision,
name (or withdrawal), and a maximum five-minute expiry. It authorizes no message,
transaction, mailbox or identity claim. EOA recovery is local; Ethereum mainnet
contract wallets require `MAINNET_RPC_URL` verification. API/schema, byte bounds,
origin and signature checks precede writes. Redis compares the exact validated
prior record and checks expiry using Redis time in the same transaction as the
revision increment. Conflicting requests require reloading/review, not a silent
retry. Storage preserves the validated JSON fields verbatim and appends only the
Redis timestamp; it does not round-trip nullable names or integer revisions through
Lua JSON codecs. Failed acknowledgements are reported as uncertain until a fresh read.

Withdrawal replaces the published name with null and retains a permanent revision
marker. Never delete this marker as routine cleanup or restore an older record:
that weakens replay and revocation ordering. No signatures or past name history
are stored by this endpoint. Operator Redis backups may retain older values;
publishing or withdrawal does not erase other people's saved copies or change
external ENS/Push records. Backup/retention policies remain an operator dependency.

Conversation lists, direct-message headers, EVM room senders and Push member lists resolve the Chat
choice before using older labels. The wallet identity remains visible; names
render as text. An explicit public choice suppresses ENS name/avatar fallback.
Absent a prior choice, existing ENS/local labels remain compatible. Public lookup
failures display a wallet address. Visible lookups are capped at 50 unique wallets
per view, refreshed every 30 seconds and independently expired at 40 seconds using
monotonic time. Focus/visibility changes discard cached views before reloading.
No public profile is persisted to local storage or message history, and lookup
results never alter authenticated identity or posting/membership permissions.
Non-EVM Push identities keep their protocol identity. Blocked DMs are not looked up.

Wallet/provider changes and leaving Settings cancel pending editor operations;
late results cannot populate another account. A cancellation cannot retract a
request already received by the server: reload the current profile before trying
again. Live multi-client/native acceptance and operator policies remain separate
from synthetic browser/Redis evidence. No profile name is a unique account handle,
search directory, contact consent or verification badge.

Invalid stored records fail closed and emit `chat_profile_storage_invalid` with
fixed schema-validity booleans and a bounded label type category. Diagnostics do
not log names, wallet addresses, signatures, stored keys/values or parser errors.
Preserve the affected record and replay fence while investigating; do not reset a
profile to revision zero to make a malformed record readable.
