# Connected Mail

Connected Mail is separate from the wallet-to-email forwarding service. It connects
a user's existing Mail mailbox to Chat with explicit read and/or send permission and a separate optional read/unread permission.
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
   listing, reading, explicit sending and separately authorized read-state updates. Scope and source authority are rechecked
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

The server relay, inbox/folders, conversations, read/compose/reply, bounded attachment sending/downloads and isolated formatted previews are implemented. The approved self-addressed pilot verified consent/callback, read/send/receive/reply, source revocation, read-only access, active Until-revoked access and a byte-exact 1 MiB attachment round trip and verified version 3 chunk download. Explicit read/unread changes were accepted on 14 October 2026: the existing synthetic message was marked read and restored to unread, with refreshed source headers confirming both states. Opening it did not change its status. These tests cover the approved account and browser, not arbitrary accounts or devices.

Production access remains restricted to configured acceptance wallets. Contract-wallet and native handoffs, account-change/device behavior, natural expiry timing, live multi-page/rich-mail acceptance and larger files remain open. Verified wallet↔email forwarding, operator retention/recovery, monitoring and combined release acceptance are separate requirements; see [REMAINING-WORK.md](REMAINING-WORK.md).

## Chat Email view

Opening an email moves keyboard focus to its subject heading; starting a new email focuses the recipient, and replying focuses the message body. Individual, conversation and conversation-member rows expose the current selection to assistive technology. Delayed reads preserve focus if the user moves to another control or leaves the tab; background polling does not move focus. Cancelled or superseded reads cannot restore content or focus. Physical-device and screen-reader acceptance remain open.

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
wallet to sign, then navigates to Mail for separate read/send and optional read-state consent. The callback
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


Attachment downloads use the explicit read grant. The current version 3 index selects 256 KiB chunks bound to folder, message, source version and MIME part. Completed chunks remain in memory while a transient failed chunk may retry at most twice. Reloading does not resume a download. Authority, integrity and malformed-response failures never retry. A valid older version 2 index selects the complete-file path. Chat verifies metadata, offsets, decoded byte count and whole-file SHA-256 before saving. Expiry, disconnect, wallet change or cancellation discards late results. No content opens or fetches remote resources automatically. Limits remain 20 indexed attachments, 1 MiB per download and 2 MiB per source message. See [connected-mail-attachments.md](connected-mail-attachments.md).

Outgoing drafts support up to four selected files totaling 1 MiB, including replies. The draft/request-ID snapshot, independent relay/source/connector validation and source receipt bind filenames and bytes to the intended send. Files stay in memory and uncertain sends require Check Sent; no automatic resend is added. See [connected-mail-attachments.md](connected-mail-attachments.md) for deployment order and the versioned transfer contract.

Formatted preview is an explicit read request bound to the selected folder, message and source version. Mail returns at most 16 KiB UTF-8/24 KiB JSON-escaped HTML plus an explicit shortened flag. Chat uses pinned DOMPurify 3.4.15 with a formatting-only tag allowlist and no email-supplied attributes, then renders the result only in a sandboxed srcdoc frame with no sandbox permissions, no referrer, and default-src none CSP. Email CSS, remote resources, links, forms, scripts, SVG/MathML and custom elements are removed. Plain text remains the default; unsupported sanitization fails closed. No claim of original-layout parity, remote image loading or full-message rendering is made.

Chat uses transfer version 2 for message reads, formatted previews and sends, and version 3 for current attachment indexes/chunks. The matching Mail and Acer readers are deployed. The approved account/browser passed a live 1 MiB transfer; physical-device and larger-file acceptance remain separate.

### Background synchronization and read status

The mailbox remains mounted across Chat views, retaining loaded content for the current wallet session. Visible, idle inbox polling runs every 45 seconds; drafts still clear on leaving Email. Mail's bounded header cache discovers folders and cursor pages, with up to 512 routes per grant, 25 headers and 28,000 UTF-8 bytes per page, and 90-second freshness. Bodies are fetched on demand. This reduces repeated loading; it is not an offline mailbox replica or a zero-latency guarantee.

Read/Unread labels reflect Mail. Updating them requires the separately consented `read-state` scope together with `read`; existing grants gain no permissions automatically. `MAIL_CHAT_READ_STATE_ENABLED=true` enables the source rollout. Disabling it blocks new scope grants and flag writes while ordinary reads remain available. Explicit controls bind updates to the selected source version and preserve other Maildir flags. Opening a message never marks it read, and uncertain writes never retry automatically. Refresh before deciding whether another explicit action is needed.


### Formatted preview browser acceptance

Isolated wallet/browser fixtures exercise the real formatting sanitizer and sandboxed `srcdoc` renderer in both ordinary web mode and with the native CSP applied. They verify readable basic formatting, an opaque frame that cannot read its parent, no active elements/attributes or external resource requests, plain-text return, shortened/missing-body notices, source identity/version/size rejection, and late responses after cancellation or wallet changes. The native-policy CI job includes these scenarios. Plain-text-only guidance is hidden while formatted content is displayed and returns with the plain view. No sanitizer bypass or CSP relaxation is used.

This is browser-policy evidence with synthetic content. It does not establish packaged native mailbox availability, contract-wallet handoff, physical-device behavior or live rich-mail acceptance; those remain separate launch checks.

### Wallet connection continuity

Mail sign-in, reads, sends and attachment verification are tied to the current provider object and connection revision, as well as the wallet address. Reconnection, account changes, disconnect and session deletion cancel in-flight work; a replacement provider reporting the same address cannot complete an older sign-in or clear an uncertain-send receipt. Receipt reservation and completion recheck the connection inside their storage locks. Temporary wallet listeners are removed after each operation.

The mailbox resets private content and drafts on a new provider session and clears them immediately on wallet-session events. A fresh mailbox check is required before content is displayed again. These client guards do not revoke the Mail grant or prove physical-device handoff acceptance; the server still independently enforces session, wallet and scope authority.
