# SMTP submission journal

`mail-smtp-journal.mjs` is the durable submission boundary for the planned
Mail-backed outbound worker. It requires Node 24 and local persistent storage.
It is not wired into the production worker yet: the current provider remains
Resend. This change does not enable forwarding or establish email acceptance.

## Storage and provisioning

An operator explicitly calls `initializeSmtpJournal({filename, key})` once, before
any submissions. Use an absolute path in an existing, worker-owned directory
with mode 0700 and a separate random 32-byte key encoded as 64 lowercase hex
characters. Initialization exclusively creates a mode-0600 SQLite file and
returns `{version: 1, journalId}`. Protect the key and pin the returned ID in the
worker's protected configuration. Never generate replacements on startup.

Normal startup uses `openSmtpJournal({filename, key, journalId})`. Missing state,
wrong key or ID, loose permissions, symbolic links at the file or its immediate
parent, and a replaced open database all fail closed. Provision the entire path
under administrator-controlled ancestors. Run one dedicated service account;
these checks do not defend against a compromised owner or root. A failed
initialization can leave a file that requires operator investigation.

SQLite uses WAL and FULL synchronization. Keep the database, WAL and SHM on a
local filesystem with reliable locking and synchronization. Do not copy just
the live database file or place it on network storage. The journal stores keyed
scope hashes, opaque receipts, states, attempts and timestamps, not addresses,
message bodies, subjects, or raw queue IDs. These records still require private
storage and a retention policy. There is no automatic deletion or reset.

## Submission contract

`submit({requestId, deadline, payload}, {authorize, send, signal})` validates one
normalized sender and recipient, bounded plain text and subject, the fixed
bridge header, the original queue ID and the original deadline (at most 23 hours
ahead). It snapshots that scope before awaiting authorization. Reusing an ID
with a changed scope is rejected. `authorize` must return exactly `true` after
checking the current Wallet authority and local binding/suppression. It must
authorize that same immutable scope. Every new attempt needs fresh authority.

A committed `uncertain` record precedes the first call to `send`. The callback
receives the snapshot and a stable Message-ID. A parallel worker, process crash,
timeout or lost acknowledgement cannot automatically repeat that submission.
An existing accepted, rejected or uncertain result is returned without a new
authorization request because no new message is sent. `inspect(command)` reads
the same scoped outcome; an absent record returns `unknown`.

The trusted SMTP adapter must return exactly one of:

- `{status: 'accepted'}` only when the SMTP server positively accepts the message.
- `{status: 'rejected', definitiveNoAcceptance: true}` for proven permanent
  nonacceptance.
- `{status: 'retryable', definitiveNoAcceptance: true}` for proven transient
  nonacceptance. Retries retain the same Message-ID and require fresh permission
  and an unexpired deadline; the fifth such attempt becomes terminal rejected.

Every thrown error or other result remains uncertain. In particular, a socket
error, timeout, cancellation or generic library error label is not proof of
nonacceptance. An abort after reservation can therefore leave uncertainty even
if no message was sent. This deliberately trades automatic availability for
duplicate prevention. SMTP acceptance is not proof of inbox delivery, and a
Message-ID alone does not provide recipient-side deduplication.

## Recovery and remaining integration

Never clear an uncertain record to retry a message. Reconcile it against
authoritative MTA evidence before any future operator recovery workflow; this
module intentionally provides no automatic reconciliation/reset API. If journal
state is lost, corrupt, or restored from an older backup, stop outbound delivery
and quarantine the queue. The pinned ID and key cannot detect rollback to an
older valid copy of the same journal. A coordinated queue/journal/MTA recovery
procedure must account for all submissions after the backup before resuming.
Do not claim exactly-once delivery or restore safety from this journal alone.

Remaining work includes the actual TLS SMTP adapter, per-job provider pinning,
the isolated Acer outbound worker, recovery of interrupted queue claims,
reconciliation/backup procedures, sender and bounce configuration,
and authorized live delivery/withdrawal acceptance. Keep launch and forwarding
gated until those checks pass.

The regression suite exercises independent database handles, scope changes,
denial and expiry, bounded retries, file replacement, reopen recovery, and an
actual child-process kill after the durable boundary. It uses synthetic callbacks
and does not send email or prove an SMTP provider's delivery behavior.

## Queue and client outcome contract

The queue accepts `uncertain` as a terminal automatic-delivery outcome. It
removes the queue pointer and encrypted payload, keeps the bounded private
receipt/history, and never converts that outcome into `stopped` merely because
its deadline or attempt limit was reached. A stale lease cannot overwrite it.
Signed status/discovery retain the usual wallet isolation. The UI disables
resending this request, preserves its lookup ID, and keeps that protection after
a later connection failure. A new composer requires an explicit action and
retains the previous ID in recovery history.

This contract does not yet connect the journal to a worker. An interrupted SMTP
claim must be recovered against the journal before ordinary queue expiry or
revocation can classify it. That provider-specific recovery, provider pinning
and the actual adapter remain required before activation. Reconciliation must
use preserved immutable scope/receipt references and authoritative MTA evidence;
it cannot depend on an expired or deleted message payload. The existing Resend
worker does not emit this new outcome yet.

## Provider binding before SMTP integration

New outbound jobs carry a private `deliveryProvider` binding. The current
`resend-v1` binding is an HMAC under the mail data key over the service, normalized
sender and provider credential. Neither the raw credential nor this binding is
included in browser receipts or worker status. The worker captures the original
credential, sender, service and encryption key before asynchronous operations and checks the binding both in
its atomic Redis claim and before provider handoff.

Only `CHIRPY_MAIL_PROVIDER=resend` is implemented by the current HTTP worker;
omitting the setting keeps that default. Empty, misspelled, SMTP or other values
fail configuration rather than falling back to Resend. SMTP configuration is not
ready for activation yet.

A missing, malformed or different binding holds the queue without changing the
job, payload, lease, attempts, timestamps or outcome, and without sending or
refreshing the successful-worker heartbeat. Authenticated worker status reports
`providerBlocked: true` and unhealthy when the head pending job has a different
or absent binding. This also catches a mismatch immediately after a previous
successful tick. The existing payload/receipt retention still applies; holding a
job does not prolong retention or establish whether it was previously sent.

Pause forwarding before deploying this migration if unpinned jobs exist. Do not
stamp them with today's provider settings: those settings do not prove the
original account, credential or delivery outcome. Reconcile against authoritative
provider evidence and original configuration. Existing receipts remain readable;
no migration tool automatically rewrites their routing or manufactures success.

Review pending jobs before changing the provider credential, sender, service or
data key. Even a credential rotation within the same account is conservatively
held; restoring the exact original configuration allows a still-authorized,
unexpired job to proceed through its original route. If the original credential
was compromised or withdrawn, do not restore it just to drain the queue; keep
sending paused and reconcile the held jobs. Opt-out and signed outcome queries
retain their usual authority checks.

This is currently one provider and one queue. A foreign/legacy head job blocks
later automatic processing until reviewed; it must not be skipped, deleted or
silently rebound to improve the health indicator. Separate provider scheduling,
SMTP instance binding and journal-first recovery of interrupted claims are still
required for the Acer worker. Do not turn on simultaneous Resend/SMTP workers
against this queue or treat this guard as a completed SMTP migration.
