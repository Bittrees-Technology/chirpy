# Connected Mail

Connected Mail is separate from the wallet-to-email forwarding service. It connects
a user's existing Mail mailbox to Chat with explicit read and/or send permission.
It does not make email end-to-end encrypted or enable automatic forwarding.

## Deployment boundary

`CHAT_CONNECTED_MAIL_ENABLED=1` and an independent 32-byte AES-GCM key in
`CHAT_CONNECTED_MAIL_KEY` are required. Existing server KV credentials are reused.
Use `CHAT_CONNECTED_MAIL_TEST_WALLETS` for a comma-separated acceptance allowlist. It gates challenges and every session use; removal of a wallet ends its Chat access, while disconnect remains possible. Clear the list only after launch acceptance. No secret belongs in a VITE variable. Disconnect remains available while the feature is disabled, provided storage/key configuration remains present. Preview deployments always fail closed. This
first browser connection is restricted to `https://chat.bittrees.org`; native and
old-origin cookie handoffs need separate acceptance. `MAINNET_RPC_URL` enables
contract-wallet signature verification, with no retries and a bounded timeout.
The source Mail flag `MAIL_CHAT_ENABLED` is a separate deployment control. Enable it only for an explicitly configured acceptance rollout after callback and mailbox tests; a successful pilot does not authorize unrestricted launch.

## Browser contract

All routes are under `/api/mail/:action`, separate from the existing `/api/mail`
forwarding endpoint. Every POST requires Chat's exact Origin except the callback,
which requires Mail's exact Origin. No cross-origin API or browser bearer flow is
exposed. Host-only, Secure, HttpOnly, SameSite=Strict cookies identify this browser;
raw session tokens never appear in JSON. The preliminary wallet-authenticated session expires after one hour. Explicit Mail consent then sets the connection duration: 30 minutes, one hour, one day, seven days, 30 days (default), or Until revoked. Finite grants cannot exceed 30 days; persistent grants use `expiresAt: null`. Existing grants are not upgraded automatically. Account switching must disconnect the old session.

1. POST `challenge` with `{wallet}` (normalized Ethereum address). Sign the returned
   exact SIWE message with that wallet; this is not a transaction.
2. POST `verify` with `{wallet,message,signature}`. The challenge cookie and the
   server's exact single-use challenge are required. Mail consent is still required.
3. POST `start` with `{wallet}`. Open the returned fixed Mail consent URL in this
   browser. Its fragment contains a PKCE challenge, state and expected wallet.
4. Mail explicitly reviews scopes and POSTs code/state/wallet to `callback`.
   Chat consumes pending state atomically, exchanges once using the server-held
   verifier, validates the source grant and stores its token only as authenticated
   ciphertext. Success redirects to `/?mail=connected` without credentials.
5. GET `status?wallet=...` returns mailbox/scopes/expiry only. It is a local session
   snapshot; source revocation is authoritatively enforced on every operation.
6. POST `operation` with `{wallet,action,input}`; Mail supports folders, message
   listing, reading and explicit sending. Scope and source authority are rechecked
   by Mail's encrypted queue. No mail content is persisted in Chat's server storage.
7. POST `disconnect` with `{}` immediately deletes Chat's server session and clears
   the cookie. It attempts source revocation. If `sourceRevoked` is false, explain
   that Chat access ended but Mail revocation should be retried from Mail's screen.

One-use challenges and sessions are stored under hashed opaque IDs in a separate
Redis namespace. Challenges and finite sessions expire; only explicitly persistent grants have no server-session TTL. Persistent browser cookies have a 400-day maximum renewed on authenticated activity; browser storage policy can still require reconnection. Source revocation and current authority remain enforced on every operation, so Until revoked is not a bypass of mailbox or factor checks. All authorization records are encrypted using their
storage key as authenticated associated data. Atomic compare-and-swap prevents
stale callbacks from reviving disconnected sessions. Expired and failed exchanges
must start fresh; never replay an uncertain code exchange. Operation responses are
size-bounded, source requests never follow redirects, and transport errors reveal
no credentials or private response bodies.

Send request IDs must survive uncertain outcomes. Do not automatically generate a
new request or send again after a timeout, permission change or lost response. SMTP
may have accepted the message before a later check failed. Mail's existing Acer
idempotency ledger preserves the exact ID and rejects conflicting/uncertain reuse.

## Remaining acceptance

The server relay, inbox/folders, conversations, read/compose/reply, bounded attachment sending/downloads and isolated formatted previews are implemented. The approved self-addressed pilot verified consent/callback, read/send/receive/reply, source revocation, read-only access, active Until-revoked access and a byte-exact 256 KiB attachment round trip. Complete-file downloads were accepted on the deployed Chat/Mail/Acer path. These tests cover the approved account and browser, not arbitrary accounts or devices.

Production access remains restricted to configured acceptance wallets. Contract-wallet and native handoffs, account-change/device behavior, natural expiry timing, live multi-page/rich-mail acceptance and larger files remain open. Verified wallet↔email forwarding, operator retention/recovery, monitoring and combined release acceptance are separate requirements; see [REMAINING-WORK.md](REMAINING-WORK.md).

## Chat Email view

The Email navigation opens a wallet-owned inbox with folders, pages of up to 25
messages, plain-text reading, composition and reply drafts. It checks the visible,
idle reading view every 45 seconds; it does not refresh while composing. Background
reads leave controls usable and never overlap. Opening a message, switching folders,
composing or disconnecting aborts and invalidates the pending poll. Late results and
errors cannot replace the newer view; current permission failures and expiry still
clear private content. Reply
uses the source-validated Reply-To address (or From when absent), a Re: subject,
and a snapshot of the selected original. Mail requires both read and send access,
rejects changed originals, and derives bounded In-Reply-To and References headers
from the original rather than trusting client-supplied headers. Missing or unsupported
message identifiers show an unthreaded-reply warning. Multiple reply recipients are
not expanded automatically. New email clears any previous reply context.
The Conversations view groups source reference chains across folders and keeps physical copies visible. The selected folder filters which conversations appear; related messages in other folders are included, with Trash excluded unless selected. Conversation members are paged newest first, and opening or replying uses the actual source folder. Changed membership invalidates old member cursors and clears a stale open conversation on refresh. No subject-only merging or wallet-identity verification is implied. Individual emails remain available. Source limits (100 folders, 10,000 messages, 8 MiB aggregate headers) return explicit errors instead of partial threads. Attachment controls and a restricted formatted preview are described below.
Older/newer page navigation uses source-bound cursors; Refresh returns to newest. Polling pauses on older pages. Moved or removed page anchors require Refresh; folders above 10,000 entries return an explicit limit rather than hiding older mail.
The reader explicitly labels its bounded plain-text preview and links to Mail.

Connect Mail validates the exact scoped SIWE message before asking the selected
wallet to sign, then navigates to Mail for separate read/send consent. The callback
opens Email. Connection status displays only mailbox, scopes and expiry. Disconnect
clears local content and the server session, and tells the user if source revocation
could not be confirmed. Expiry, revoked access and wallet changes discard private
results. Chirpy and native origins link to canonical Chat for this browser flow;
this does not verify native mailbox integration or legacy-origin migration.

Draft content stays in memory and clears on leaving Email. A pending send stores
only a random receipt ID and timestamp in wallet-keyed local storage before dispatch.
Web Locks coordinate receipt allocation across tabs; unavailable storage or locks
blocks sending. Errors, cancellation and account changes preserve that receipt.
There is no automatic resend. Users must check Sent and explicitly acknowledge
possible delayed delivery before clearing the warning. Receipt IDs pass unchanged
to the source connector idempotency ledger. This is not cross-device draft or send
coordination. Live integrated acceptance remains required before launch/forwarding.


Attachment downloads use the explicit read grant. Show attachments requests a bounded index; selecting a file requests its complete contents once, bound to the folder, message ID, source version and MIME part. Larger encrypted queue results use private object storage. Current source authority is rechecked, and Chat verifies metadata, decoded byte count and whole-file SHA-256 before an explicit application/octet-stream download. Expiry, disconnect, wallet change or cancellation discards late results. The older 12 KiB chunk API remains for compatible clients. No content opens or fetches remote resources automatically. Limits remain 20 indexed attachments, 256 KiB per download and 512 KiB per source message; unsupported multipart attachments and oversized messages return explicit errors.

Outgoing drafts support up to four selected files totaling 256 KiB, including replies. The draft/request-ID snapshot, independent relay/source/connector validation and source receipt bind filenames and bytes to the intended send. Files stay in memory and uncertain sends require Check Sent; no automatic resend is added. See [connected-mail-attachments.md](connected-mail-attachments.md) for deployment order and the complete-file contract.

Formatted preview is an explicit read request bound to the selected folder, message and source version. Mail returns at most 16 KiB UTF-8/24 KiB JSON-escaped HTML plus an explicit shortened flag. Chat uses pinned DOMPurify 3.4.15 with a formatting-only tag allowlist and no email-supplied attributes, then renders the result only in a sandboxed srcdoc frame with no sandbox permissions, no referrer, and default-src none CSP. Email CSS, remote resources, links, forms, scripts, SVG/MathML and custom elements are removed. Plain text remains the default; unsupported sanitization fails closed. No claim of original-layout parity, remote image loading or full-message rendering is made.
