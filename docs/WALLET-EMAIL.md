# Wallet-authorized outbound email pilot

Implemented: a wallet-signed email composer in Channels, signed status queries,
a durable encrypted Redis outbox, Resend delivery worker and private verification
record import/revocation. Shipping this code **does not activate email sending**.
No real customer messages, credentials or verification records were created.

This is explicit outbound composition, not automatic copying of existing XMTP
messages. It needs neither a custodial member wallet nor a dedicated XMTP bot.
Wallet signatures authorize the server to send an email; they never transfer
funds or expose the member's private key. EOA wallets are supported; smart-contract
wallet signature verification is not part of this pilot.

## Deployment configuration

Use `selfhost/mail.env.example` as the configuration inventory. Set all values
through the deployment secret manager. Use a verified dedicated sender address,
a restricted Resend sending key, a separate 32-byte queue encryption key, an
independent worker secret and durable Redis. Do not reuse the room gate's keys.
The service identity must be the stable HTTPS `/api/mail` URL. Preview deployments
always remain disabled even if environment variables are inherited.

A separate machine is not required for the first outbound service: Vercel hosts
`/api/mail` and `/api/mail-worker`; an operator-controlled scheduler invokes
`node scripts/mail-worker.mjs` once per minute with the service URL and worker
secret supplied through its environment. One tick claims at most one message.
No scheduler is automatically installed by this change. Monitor backlog age and
increase safe tick frequency for higher volume; do not remove quotas to compensate.
The worker has a configured 60-second limit. On timeout the lease/retry rules apply.

Keep the deployed `CHIRPY_MAIL_ENABLED=0` until recipient verification, consent,
suppression operations, provider/domain configuration and synthetic delivery
acceptance are complete. Configure a small explicit `CHIRPY_MAIL_SENDERS` EOA
allowlist. Sender wallets are limited to 20 new requests per rolling 24-hour
counter window; recipients to 50 across all senders. Recipient quota keys fold
address case conservatively, matching suppression, so verified spelling variants
share the same limit. Binding checks still require the exact verified address. Anonymous wallet creation
cannot bypass the sender allowlist. This is not a public bulk-mail relay.

## Verification boundary and wallet.bittrees.org

Recipient authorization is a **private, correspondent-specific permission**, not
an assertion supplied by the sending browser. An authoritative verifier must
prove email control and record that the recipient opted to receive mail from the
specific sender wallet. Linking a member's own email and wallet does not by itself
supply a different recipient's consent. A valid record contains:

- `wallet`: canonical lowercase sending EOA address.
- `email`: verified recipient, with original local-part case and lowercase domain.
- `verifiedAt`, `consentedAt`, `expiresAt`: Unix milliseconds; consent follows
  verification and must still be valid.
- `evidenceId`: private verification/consent audit receipt reference.
- `version`: generated afresh by the trusted importer; never chosen by the browser.
- `revoked`: explicit boolean; importing a new version invalidates old queued work.

For a supervised pilot, an authorized operator may import evidence from an actual
approved verification process using `node scripts/mail-binding.mjs import <private-record.json>`.
The importer **validates the record shape, not the underlying evidence**. It is
not an email verifier and must not be exposed as a public API. Never fabricate
verification timestamps or treat a support request as proof of mailbox control.
The script needs the local complete configuration (`CHIRPY_MAIL_ENABLED=1` in that
local environment) but does not change deployment variables or send email.
Use `revoke` with a private file containing the wallet/email pair to replace the
permission immediately. Remove expired audit records through the identity service's
retention policy; Redis bindings expire automatically at their specified expiry.

The proposed shared identity service at `wallet.bittrees.org` should eventually
own mailbox verification, proof of wallet control, consent receipts and revocation.
It should publish these narrow delivery grants to this private store or replace
the adapter with a separately authenticated service. Chirpy keeps message signatures,
queueing and delivery. Mercado keeps its own sessions, deal grants and staff roles.
There is no public email-to-wallet lookup, browser-accessible binding write, key
export path or automatic migration of app permissions in this implementation.

Storage and provider requests reject HTTP redirects, so an endpoint redirect cannot forward private commands or email bodies to another destination. A provider redirect leaves the existing job retryable under its original idempotency key and bounded retry policy.

## Delivery and failure semantics

Each signature includes the service, action, sending wallet, request ID, recipient,
subject, text and five-minute authorization expiry. Email enqueueing is idempotent
for the same wallet/request/content, even when a retry uses a fresh signature.
Reusing an ID for different content fails. Status queries require a fresh signature
from the same wallet; IDs are not bearer credentials.

Redis atomically rechecks signature expiry using millisecond-precision server time,
as well as the binding version and shared quotas, while creating the
job and payload. AES-256-GCM encrypts the immutable provider payload with the job
key as authenticated context. Payload TTL is 24 hours. Metadata TTL is 30 days;
the queue index contains opaque job hashes and is cleared as the worker processes
missing/expired records. Only the request ID is saved in the browser for recovery;
email content is not written to local storage by the composer.

Workers claim a 60-second lease, recheck consent/version and the sender allowlist
before forwarding, and make at most five attempts with exponential delay capped
at 15 minutes. Sending stops 23 hours after enqueue, inside Resend's 24-hour
idempotency window. Retries reuse the exact provider payload and idempotency key,
including after a send succeeded but its acknowledgement was lost. The encryption
key must remain available throughout pending jobs; changing it cannot decrypt old
payloads and requires an operator recovery procedure.

`queued`, `sending`, `accepted`, `stopped` and `unknown` are distinct. Accepted means
provider acceptance, not delivery or reading. Stopped can be ambiguous after an
interrupted provider attempt: reconcile with provider records before resending.
Revocation stops queued work and later attempts; an in-flight email cannot be
recalled. The composer locks request content during retries and keeps the request
ID available for signed status checks after reload.

Before opening a send signature, the browser reserves the request ID in a
wallet-and-service-scoped recovery record under a Web Lock and verifies the write.
Missing locks, unreadable/malformed records, failed writes and a competing active
reservation prevent submission. Retries require the same active ID and content
fingerprint; only signature expiry may change. Retries stop 23 hours after the
original local reservation, without renewing that deadline, so an old open tab
cannot recreate a send after server deduplication expires. A clock earlier than
the original reservation also refuses retries. Old IDs remain available for status
checks. The record contains IDs, reservation times and fingerprints, not raw
recipients, subjects or bodies. Fingerprints are not anonymous
data. Existing `chirpy:mail-receipt:<wallet>` values are read without deletion or
replacement. Editing a manual status lookup does not overwrite recovery storage.

Starting a new message clears only the matching active selection, preserving old
IDs for separate signed lookups in **Forwarding request history**. A stale tab cannot clear
a newer reservation. Storage changes update other open forms, and late status
responses cannot replace the result for a newly selected request. Cancelling a
browser request does not recall an already submitted email.

The recovery record is bounded to 100 IDs and does not silently evict earlier
requests. At capacity, new sends stop. Channels offers encrypted request-ID
backup, reviewed additive restore, and explicitly confirmed cleanup, even while
forwarding is disabled. These actions require current wallet ownership proofs.

Backups contain only version, wallet, canonical service, export time, active ID
and at most 100 unique IDs. They exclude message content, fingerprints, original
retry clocks, wallet keys and signatures. The separate `chat-email-requests` v1
format uses AES-256-GCM and PBKDF2-SHA-256 (600,000 iterations), purpose-specific
authenticated data, fresh salt/nonce, an 8 KiB plaintext limit and 16 KiB file
limit. The existing settings recovery format is unchanged. Passphrases are not
stored and cannot be recovered by Chat.

Unlock is read-only; apply requires another fresh ownership proof and the exact
reviewed local revision. Restore accepts only the same wallet and canonical mail
service; it never fetches or trusts a URL from a file. It adds lookup-only records
with null fingerprint/timestamp. Existing records retain their original retry
limits, and the current active ID takes precedence. A restored active ID is
selected only if no local request is active. No message is submitted by recovery.
Archives from a different service are refused: cross-origin transfer works only
when both clients use the same canonical API service. Historical service-alias
migration needs a separately verified identity/storage migration; a file cannot
authorize one.

Export reopens its encrypted result for verification and checks that storage is
unchanged before requesting a download. This does not prove the file was saved.
Cleanup requires acknowledgement that the file and passphrase were saved, a new
wallet proof, and the exact exported revision. It keeps the active ID and legacy
compatibility ID, removing only other backed-up entries in a single verified
localStorage write. The legacy slot is never rewritten/deleted. Keep the backup
for future signed lookups; this is not provider-side retention or delivery proof.

Apply and cleanup share the send reservation Web Lock, fail on malformed storage,
capacity overflow, changed state or missing locks, and never auto-repair or evict
records. If a write completes before its acknowledgement fails, reload the list
to inspect the result; keep the original archive. Same-origin current clients
cooperate. Old clients and manual tools may not, so refresh other tabs before
recovery; cross-device and cross-origin concurrent sending still need rollout
acceptance. Physical native-device recovery remains to be verified. Keep
forwarding disabled until the broader launch requirements pass.

The email plainly identifies the authorizing wallet and the Chirpy service. It is
text-only, with a 120-character subject and 16 KiB body. No attachments, HTML,
remote previews, payments or administrative commands. Email replies are **not**
forwarded into XMTP. The gateway and email provider can read the message.

## Activation acceptance and remaining work

Completed automated coverage includes signature substitution/expiry, header
injection, cross-origin and worker authentication rejection, concurrent enqueue
and worker claims, changed-content replay, encrypted payloads, permission changes,
quotas, crash-after-publish retries, retry limits, expired jobs and wrong keys.
Browser tests cover signing, uncertain responses, stable retry IDs, recovery and
truthful provider-acceptance status. Real Redis is required for atomicity tests.

Still required before an operator activates the supervised pilot:

1. Approved verification/recipient-consent process and genuine records, secret
   custody, verified sender domain, provider access and a scheduled worker.
2. Synthetic deliverability and failure tests using explicitly consenting test
   accounts; backups, key rotation/recovery rehearsal, backlog/worker alerts and
   documented support ownership.
3. Provider bounce/complaint monitoring with immediate operator suppression for the
   pilot. Durable recipient-wide suppression is implemented below. Public enrollment
   still requires provider webhook configuration/acceptance, broader abuse controls
   and approved support policy before removing the allowlist. Signed event processing
   and recipient self-service opt-out are implemented below.
4. Approved retention/privacy notices and a recipient support/opt-out contact.
   Provider and recipient copies have separate lifetimes from the Chirpy queue.
5. Smart-contract wallet support, email-only signup/key export, inbound email to
   wallet, reply aliases, full email conversation history and native-device
   acceptance remain separate work.

Sources: [Resend send API](https://resend.com/docs/api-reference/emails/send-email),
[provider idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys),
[Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration).

## Worker monitoring

For a supervised Resend deployment, use the disabled-by-default
[API scheduler](../selfhost/MAIL-API-SCHEDULER.md). It checks private health after
each tick and requires only the worker capability on the scheduler host. The
local SMTP worker has a separate deployment contract and must remain disabled
when the selected transport is Resend.

Run `node scripts/mail-worker.mjs status` with the same service URL and worker
secret as the scheduled tick. It performs an authenticated, read-only snapshot;
it never dequeues mail, contacts the provider or refreshes the heartbeat. The
JSON exposes counts and times only, with no wallet, recipient or job identifiers.
A successful tick (including an empty queue) records a Redis-clock heartbeat with
a 24-hour lifetime. Status exits nonzero if no successful tick was recorded in
five minutes, the heartbeat is in the future, or the oldest due queue entry is
more than five minutes overdue. `oldestDueAgeMs` measures eligibility delay,
not total message age. Future retries remain in `queued` but not `due`.

Schedule ticks at least once per minute and have an independent monitor invoke
status and alert on failure. Those external schedules and alert recipients still
need provisioning. Healthy means the worker is alive and its due queue is moving;
it does not prove email delivery, sender verification or overall release readiness.
Provider failures may be retrying while worker status remains healthy; continue
provider bounce/complaint monitoring and acceptance checks. Explicit unknown
worker actions return 400 without sending; a bodyless POST remains a legacy tick.

## Recipient-wide suppression

For a genuine bounce, complaint or opt-out, an authorized operator can run
`node scripts/mail-suppress.mjs /private/path/record.json`. The private JSON record
must contain `email`, `reason` (`bounce`, `complaint` or `opt-out`) and `evidenceId`
referring to the independently retained support/provider evidence. Never fabricate
recipient consent or expose this trusted operator command as a browser API. It can
run while sending is paused, with the same configured private service/storage
credentials; preview configuration remains rejected. Do not commit the record.

Suppression applies to every sending wallet for that Chirpy service. It uses a
case-folded recipient hash in private storage, keeps only reason and an evidence
hash, and has no automatic expiry. Hashes are not anonymous data. Include these
records in protected backups and operator retention review. Repeated suppression
is idempotent; re-importing consent does not remove it. No automatic reactivation
or suppression-removal command is provided.

Enqueue checks suppression atomically before creating a job or charging quota.
Workers check it while claiming new jobs and again immediately before provider
handoff, including jobs created before this feature. A stopped job loses its
queued payload; existing receipt status remains available. Already handed-off
mail cannot be recalled. Signed provider event ingestion uses the same enforcement, as described below.
Recipient self-service opt-out is described below.

## Signed provider events

`/api/mail-events` accepts Resend `email.bounced` and `email.complained` events.
It verifies the exact raw bytes using the pinned Svix library, including its
five-minute delivery-signature timestamp check, before parsing JSON or touching
storage. Bodies are bounded to 64 KiB and five seconds. One recipient and the
configured plain sender address are required; other applications and unsupported
event types are ignored. This endpoint cannot send mail, grant verification or
remove suppression. It does not mark a message delivered or read.

Set `CHIRPY_MAIL_WEBHOOK_ENABLED=1` and `RESEND_WEBHOOK_SECRET` from the provider's
webhook endpoint only after configuring that endpoint and retaining its secret
securely. This activation is separate from `CHIRPY_MAIL_ENABLED`: late complaints
continue to be processed while sending is paused. The remaining mail service and
storage configuration must still be present. Preview deployments reject events.
No webhook or secret has been provisioned by the implementation.

Register the production HTTPS endpoint for these two events. Verify a synthetic
signed event in the actual deployed runtime, a forged event rejection, concurrent
redelivery, storage-outage retry and suppression of a previously queued synthetic
message before activation. Monitor provider webhook failures separately from the
worker heartbeat. This deployed acceptance remains an external dependency.

A Redis transaction records the event digest for 30 days and the suppression
without automatic expiry. Concurrent/retried delivery is idempotent; reusing an
event ID for a different scope returns 409. Storage failures return 503 so the
provider can retry. The event ledger stores hashes only, not subjects, bodies or
addresses. Keep the private ledger and suppression records in protected backups;
retention and recipient reactivation policy still require operator review.

References: [Resend signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests),
[bounces](https://resend.com/docs/webhooks/emails/bounced),
[complaints](https://resend.com/docs/webhooks/emails/complained), and
[Vercel Web Handler API](https://vercel.com/docs/functions/functions-api-reference).

## Recipient self-service opt-out

New outbound emails include a private link to `/mail/optout/`. A recipient can
stop future mail to that address from every Chirpy wallet without a wallet login.
Opening or previewing the link never changes preferences: the page requires an
explicit confirmation, and the API accepts POST only. Anyone possessing the link
can suppress that recipient, so treat forwarded emails and links as private.
The link never permits sending, reading history, identity linking or reactivation.

The 256-bit random capability is in the URL fragment, removed from the address bar
on page load, and sent only in the confirmation POST body. This standalone page
loads no analytics, external resources or messaging SDK, uses no browser storage,
and offers English and Spanish instructions. Failed requests remain retryable;
unknown links never display a success confirmation. After reloading, reopen the
original email link because the page deliberately does not persist its token.

Enqueue atomically stores a hash of the token mapped to a private recipient hash.
Denied/duplicate requests create no additional link record. Accepted-message
payload deletion and encryption-key rotation do not break the link. Link records
have no automatic expiry; include them with suppression records in protected
backups and the operator's retention policy review. Deleting these records breaks
previously delivered opt-out links and must not be treated as routine queue cleanup.

Confirmation atomically adds durable suppression. Existing receipt statuses remain
truthful, queued mail stops at the next worker check, and email already handed to
the provider cannot be recalled. The endpoint remains usable while sending is
paused, with the existing service/storage configuration retained. Preview remains
disabled. Already delivered emails from before this feature require the documented
operator suppression path. Actual email-link delivery, provider rewriting/scanning,
mobile browsers, signed-device acceptance and approved recipient support ownership
still require deployment acceptance; no real messages were sent by these tests.

## Offline configuration preflight

Run `node scripts/mail-preflight.mjs` with the intended settings supplied through
an operator-controlled environment. Do not put credentials in command arguments.
The command performs no network requests, storage writes, sends or activation.
It reports missing variable names and boolean validation results only; it never
prints addresses, wallets, endpoints or secret values. Nonempty malformed settings
may produce an empty `missing` list with `configurationValid: false`; use the
configuration requirements above to correct them.

Exit 0 means outbound and webhook settings pass the existing runtime validators,
even while sending is paused. Exit 1 means incomplete or invalid configuration
(including preview environments); exit 2 means unsupported command arguments.
`sendingEnabled` and `webhookEnabled` additionally reflect their activation flags.
The check does not modify environment variables or bypass the preview guard.

This is configuration validation only. It cannot verify credential validity,
provider domain ownership, webhook registration, scheduler health, recipient
consent, backups, alert delivery or real-device acceptance. Complete those external
checks before activation; `externalVerificationRequired` always remains true.

## Wallet-backed authorization mode

Configure both `CHIRPY_MAIL_IDENTITY_URL` (the exact HTTPS Wallet `/api/service/delivery` endpoint) and `CHIRPY_MAIL_IDENTITY_SECRET` through the server secret manager. Partial/invalid configuration disables sending; independent opt-out, suppression and provider-event handling do not require Wallet configuration. Previews remain disabled. This code does not configure or activate that service. The existing provider/domain, scheduler, allowlist and operational acceptance are still required.

In this mode each trusted private mapping also carries `identity: { bindingId, version }`, referring to a genuinely verified Wallet binding. Local record fields are queue indexes and an additional revocation gate, not proof of current Wallet consent. The browser cannot supply this reference. Chat requires Wallet's exact sender-specific forwarding consent and matching destination before enqueue and immediately before every provider attempt. Missing mappings or denied/mismatched resolution cannot send. Transient failures preserve the original job/payload and bounded retries.

Chat derives an opaque delivery ID from the existing service-scoped job key and uses the signed immutable message digest as the content hash. The queued record pins this scope and Wallet endpoint. Same-message retries reuse both and the provider idempotency key. Removing or retargeting Wallet configuration cannot downgrade existing jobs; enabling Wallet mode does not silently upgrade old jobs. Drain or reconcile old jobs before changing modes. After the Wallet network check, Chat rechecks local binding version, expiry and recipient-wide suppression before handoff.

The response must match binding/version, sender, delivery ID, content hash and exact recipient, with an unexpired bounded deadline. Responses are capped at4KiB and redirects are rejected. Wallet resolution grants no inbound bridge identity, mailbox access, room membership, key custody, or assurance that a provider delivered/read a message. Live consumer credentials, mapping enrollment and self-addressed bridge acceptance remain separate deployment work.


### Protected Wallet deployment access

For a Wallet entry behind Vercel Deployment Protection, configure the additional
paired server settings `CHIRPY_MAIL_IDENTITY_ACCESS_ORIGIN` (for example,
`https://wallet.bittrees.org`) and `CHIRPY_MAIL_IDENTITY_ACCESS_SECRET` with a
dedicated automation secret from the **Wallet** project. For inbound authorization,
use `CHAT_MAIL_INBOUND_IDENTITY_ACCESS_ORIGIN` and
`CHAT_MAIL_INBOUND_IDENTITY_ACCESS_SECRET`. Omit both values for an unprotected
entry; an incomplete or mismatched pair disables that configuration.

The access origin must exactly match the configured Wallet endpoint’s HTTPS origin,
with no path, credentials, query, fragment or custom port. The deployment token is
independent of the scoped Wallet service credential. Both credentials travel only
in headers, with redirects rejected and cookies omitted. No cookie is requested,
no token enters a URL, and no fallback drops either credential after refusal.
The caller’s `VERCEL_AUTOMATION_BYPASS_SECRET` is deliberately ignored: that value
belongs to the calling project and does not establish access to Wallet.

This supports the [Vercel automation access header](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).
It grants access through the deployment entry only; Wallet still independently
checks service scope, binding version, direction, sender/recipient and current
consent for each operation. No protected deployment is made public by this code.
Provisioning the dedicated token is a separate administrator action; do not
activate sending or claim live acceptance from a synthetically tested header.

The private inbound sender JSON also needs `identity.access: { origin, secret }`
when its endpoint is protected. Keep it in the same private credential custody as
`identity.credential`; never include it in browser configuration. Provisioning and
sender startup validate the optional access before registering or claiming a send.
Rotating access credentials at the same endpoint preserves the sender journal
identity and must not reset publication receipts or uncertain attempts. Configure
and verify access for both the queue worker and isolated sender before enabling
intake. Existing source, recipient, provider, scheduler and recovery gates remain.


## Signed outbound receipt history

Signed status queries now return a bounded `receipt` projection for the wallet's exact request ID: version 1, queue creation time, latest recorded state-change time, processing attempt count and the original 23-hour retry deadline. Redis time records enqueue, claim, stop and finish transitions. A read neither requeues work nor extends the record's existing 30-day retention. Provider acceptance still does not confirm delivery or reading; processing attempts can include authority checks that stop before provider dispatch.

The projection excludes recipients, content, provider IDs, leases, binding keys and identity authorization. A mismatched owner/ID or malformed record fails closed. Unknown requests return no fabricated receipt; an expired or missing record does not prove that no email was sent. Records created before transition timestamps retain an explicit unknown update time until a new transition. Existing status-only clients remain compatible, and new clients support older servers without detailed receipts. Signature text, queue keys, local recovery storage and encrypted export formats are unchanged.

Chat's forwarding history keeps independently checked results for up to 100 request IDs in the current wallet/provider session. It labels the check time, preserves the active recovery ID, does not persist results or message content, and removes old details if a recheck fails. Provider/session replacement clears the view. Each lookup requires the existing wallet signature; no send is needed to inspect a saved receipt. Inbound history and live provider-event reconciliation acceptance remain unfinished. Live forwarding infrastructure and production acceptance are still required.


## Recovering lost outbound request IDs

An enabled service advertises `historyVersion: 1`. Chat then offers **Find missing forwarding request IDs**. Each page requires a separate wallet signature binding the service, wallet, nonce, cursor and five-minute expiry to a read-only history command. Send and status authorization text is unchanged. The server checks expiry again using Redis time and returns at most 25 retained IDs, without recipients, message contents, delivery identity or provider metadata. Other wallets cannot use the cursor to access this wallet's records. A removed cursor fails explicitly; start a fresh lookup.

The wallet-specific index contains opaque job keys and is capped at 640 entries. New enqueues add the pointer atomically. Old pointers are pruned at enqueue, lookup or maintenance; the index expires 30 days after its newest enqueue. Individual receipts retain their original 30-day expiry, and lookup neither extends that expiry nor changes jobs, payloads, quotas or the outbox. Missing or expired jobs are omitted. An empty page is not proof that no message was sent. Keep encrypted backups for older IDs and unusual legacy histories exceeding the index cap.

Users review each page before saving, then prove current wallet ownership again. Saving appends lookup-only IDs, preserves an existing active request and rejects concurrent storage/session changes. With no active request, the first found ID becomes active for a status check before composing. No message content or retry permission is restored. The 100-ID device limit refuses excess pages without evicting existing recovery data; use encrypted backup and acknowledged cleanup before retrying.

### Indexing retained legacy receipts

Existing receipts need a one-time operator backfill. With the private production mail configuration loaded securely, run:

```sh
node scripts/mail-history-index.mjs --dry-run 0
```

Repeat with each returned `cursor` until `complete: true` (`cursor: "0"`). Inspect every page; `validated` counts structurally valid receipts, not guaranteed live/indexable records. Repair malformed records before proceeding. Then repeat the full traversal starting with `--apply 0`, passing each returned cursor until complete. Apply rechecks ownership, creation time and remaining TTL atomically, skips records that have expired, and may be repeated safely. `indexed` counts accepted maintenance operations, including already-indexed records, rather than newly created pointers.

Each invocation requests a SCAN page with COUNT 50 (a Redis hint), rejects pages over 256 keys, excludes payloads and limits each parsed receipt to 16 KiB. Output contains aggregate counts and a scan cursor only. Apply adds bounded index pointers; it never extends receipt retention, dispatches or requeues mail. Backfilled index TTL follows remaining receipt retention. The command can run while forwarding is paused through an in-memory configuration override; it does not change deployed activation flags. Dry-run reads no payloads and performs no writes. Production backfill and signed lookup acceptance remain deployment checks; this change does not activate forwarding.


## Correlated provider delivery reports

The signed status response can include `delivery: { version: 1, events: [{ type, occurredAt }] }` for an accepted request. These are independent verified provider facts, with the latest provider timestamp for each of seven supported types: sent, delivered, delivery_delayed, failed, bounced, complained and suppressed. Out-of-order delivery does not erase earlier failure types. Queue acceptance, provider delivery and reading remain distinct. Per [Resend's event contract](https://resend.com/docs/webhooks/event-types), delivered means the recipient mail server accepted the message; it does not prove inbox placement or reading. Open/click tracking events are ignored.

Register these seven event types with the existing production webhook endpoint and signing secret, then verify actual delivery, delay, bounce/complaint, duplicate/replay and missing-event behavior before activation. No provider settings are changed by this code. The webhook still verifies the exact signed body, exact configured sender and one plain-address recipient; previews remain disabled and independently configured webhooks can continue while sending is paused.

Events correlate through an opaque key derived from the service, provider message ID and recipient suppression key. An event can arrive before the worker records provider acceptance; the later signed status query then finds it. No lookup by recipient is exposed. Only accepted receipts with retained correlation fields receive evidence; unknown requests and unavailable/expired events never imply successful delivery or failure. This does not resolve a provider-accepted send whose response and all idempotent retries were lost before the job retained its provider ID; operator reconciliation remains required for that ambiguity.

Evidence contains at most seven type/timestamp pairs and expires 30 days after first storage; later events and duplicates do not extend that existing expiry. Deduplication markers expire after 30 days. As with existing event markers, a newly replayed event after expiry can create new evidence, but cannot resurrect an expired job. Signed status reads never modify a job, payload, queue or evidence expiry. Provider IDs, recipients, content, raw diagnostics, URLs and signature material are not returned or stored in the evidence. Local UI observations disappear with the wallet/provider session or a failed recheck; saved recovery IDs and retry permission are unchanged.

Bounce/complaint suppression remains permanent, independent of delivery evidence expiry, and is applied even if evidence storage is damaged. Older untimed bounce/complaint payloads still suppress without fabricated event timestamps. Existing legacy suppression markers are checked and preserved without TTL extension; consistent replay can add missing evidence. Conflicting reuse of an event ID is rejected. Other event types require a valid provider timestamp. Repair malformed evidence and replay through the provider's authenticated mechanism; no receipt status or provider report is proof that a retry is safe. Production event enrollment, missed-event review and operator acceptance remain required.
