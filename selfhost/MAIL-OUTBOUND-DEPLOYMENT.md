# Private Acer SMTP worker

This worker is implemented but **disabled by default**. Synthetic acceptance is
not permission to enable public forwarding. Connected Mail and machine forwarding
have separate authority; do not borrow a member's mailbox/session credentials.

## Private deployment

Use Node 24 on Linux, a dedicated non-login service account, root-owned immutable
code/runtime, a root-owned protected environment file and a worker-owned 0700
local state directory. Install the exact `mail-worker.package.json` and lockfile
with `npm ci --ignore-scripts --omit=dev`; preserve `server`, `packages/core` and
`selfhost` relative paths. The worker listens on no HTTP port. Its only outbound
paths are the configured Redis REST endpoint, Wallet authority and same-host SMTP.

A supervisor invokes `node selfhost/mail-outbound-worker.mjs --once` at most once
per minute. Configure a 90-second execution limit, no overlapping scheduled jobs,
UMask 0077, NoNewPrivileges, a read-only root filesystem except the journal state,
restricted home access and memory/process limits. Deployment tooling must not
implicitly start a timer. Use `--status` for a content-free health check (exit 2
when disabled or unhealthy). A completed uncertain send also returns exit 2;
route nonzero exits to the chosen operator alert channel without logging payloads,
SMTP replies, credentials or wallet addresses. The persistent uncertain-receipt index keeps status degraded even after an idle
tick or restart. Private status also checks journal reservations older than the
60-second lease window; a current in-flight send is not immediately treated as a
stale hold. Failed or unhealthy scheduled ticks clear the healthy heartbeat, so
remote status cannot keep reporting that worker as healthy. Read-only status and
maintenance do not alter liveness. None of these checks proves inbox delivery.

Start from `mail.env.example` and `mail-outbound.env.example`. SMTP requires
`CHIRPY_MAIL_IDENTITY_URL/SECRET` and current correspondent-specific Wallet scopes.
The relay host must be loopback. STARTTLS is mandatory except implicit TLS on port
465; certificate/name verification and TLS 1.2 minimum cannot be disabled. Configure
one protected PEM CA file and explicit DNS server name. Any authentication pair
is used only after verified TLS. Acer's current private relay presents identity
`acer-server`; independently verify its CA fingerprint through the trusted host
channel before using the example path. TLS success alone proves no sender/domain
permission or external delivery. Never change existing Mail transport policy merely
to bypass these checks.

Provision the journal **once**, as the service account, with the separate random
32-byte hex key and absolute path in protected configuration. For example, from
the installed release with that environment loaded:

```js
import {initializeSmtpJournal} from './selfhost/mail-smtp-journal.mjs';
const result = initializeSmtpJournal({
  filename: process.env.CHAT_SMTP_JOURNAL_FILE,
  key: process.env.CHAT_SMTP_JOURNAL_KEY,
});
console.log(result.journalId); // Pin in protected configuration; never print the key.
```

Never rerun initialization to fix missing/corrupt state. Pin the returned ID in
`CHAT_SMTP_JOURNAL_ID`. With complete mail configuration and explicit provider
`smtp`, run `--profile` offline. This prints only the opaque transport binding;
it does not connect, send, claim queue work or provision journal state. The offline profile command validates the complete configuration independently
of the local admission flag; keep Vercel admission disabled and
`CHAT_MAIL_OUTBOUND_WORKER_ENABLED=0` during preparation.
Copy the profile to both protected Acer and Vercel mail configuration. Keep SMTP
credentials and journal secrets exclusively on Acer. All effective transport,
trust, authentication, sender, service and journal changes require review of the
old queue; changing a profile is not a migration.

## Single-provider cutover and recovery

1. Pause admission and the previous provider's scheduler. Inventory pending and
   uncertain work using original credentials/evidence; reconcile it without
   automatically repinning or dropping a foreign/legacy head job.
2. Preserve coordinated Redis/journal/MTA backups and verify recovery in quarantine.
   An older valid journal cannot detect its own rollback. Never restore and resume
   blindly. Private receipts retain 30 days; encrypted queue payloads retain 24 hours;
   the journal has no automatic deletion. Select a retention and reconciliation owner.
3. Verify the configured sender, return path, domain authentication, bounce/complaint
   ingestion, suppression workflow and operator alerts. The existing Resend webhook
   does **not** establish SMTP bounce evidence. Until this path is configured, keep
   forwarding disabled. This worker sends only one authorized recipient and no Bcc.
4. Perform authorized live delivery, refusal, opt-out/withdrawal, identity outage and
   recovery acceptance using approved identities. Confirm recipient delivery rather
   than interpreting SMTP acceptance as inbox delivery.
5. Enable the isolated worker and admission only after those gates pass. Vercel
   can enqueue/read SMTP receipts but cannot drain without the private adapter.

On an expired sending lease, the worker reads the pinned journal result before
consent/expiry/payload checks. A recovered accepted or uncertain result is retained
even when the original content is gone or permission was revoked. Read-only
recovery does not authorize another send. Only unknown/proven-unsent outcomes with
intact original scope, fresh Wallet/local authority, matching lease and remaining
bounds can enter SMTP. Redis preserves a content-free recovery reference before
the journal can reserve a submission. Journal/storage errors leave evidence for
recovery and do not report a successful tick.

TLS/auth preflight has no MAIL/RCPT/DATA and can be retried within queue bounds.
After the durable boundary, only explicit negative SMTP transaction replies
permit retry (4xx) or definite stop (5xx); generic socket/timeouts remain uncertain.
A lost final acknowledgement is never an automatic retry. A stable Message-ID is
for correlation, not recipient-side deduplication. A lost acknowledgement with no later definite journal result still requires
authoritative MTA evidence and an operator-approved recovery procedure. No reset,
manual success assertion or force-retry API is supplied.

## Acceptance coverage

Tests use a private synthetic STARTTLS server, real Redis and SQLite. They cover
TLS/name/CA failures, plaintext downgrade rejection, bounded SMTP refusals,
acknowledgement loss, fresh Wallet/local authority and lease changes, lost Redis
completion, removed payloads, expiry/revocation, missing/replaced journals,
provider mismatch, stable MIME scope and content-free recovery. The journal suite
also kills a real child process after its durable boundary. No fixture sends an
external email. The isolated Linux runtime check verifies pinned dependencies and
disabled CLI behavior. Live sender, operational and public-launch gates remain open.


## Persistent holds and bounded reconciliation

`--status` exposes counts only. Newly finished uncertain receipts enter a private
persistent index atomically with their terminal outcome. Index pointers do not
expire with the user receipt and are not removed simply because the queue is
empty. The SQLite journal independently retains uncertain reservations. An orphaned
pointer remains an alert requiring retention/recovery review; missing content or
an absent journal row cannot prove nonacceptance. Do not delete an index or journal
to silence monitoring. Monitor the private worker as well as the authenticated
HTTP status; remote status cannot directly inspect Acer's filesystem.

Explicit maintenance commands work with forwarding and the supervisor disabled,
and do not require an available Wallet authority. They still require the original
service/data key/sender/profile, private journal and Redis configuration. They
never connect to SMTP, read message bodies, authorize new sends or refresh health.

- `--inspect [receipt-cursor]`: read up to 25 unresolved journal receipts. Output is
  only receipt IDs, attempt counts and timestamps; this is private operator output,
  not a public endpoint or a routine log. A non-null next cursor continues the page.
- `--review [cursor]`: read up to 25 indexed receipt pointers and report aggregate
  eligible/unresolved/orphaned/conflicting counts. It writes nothing.
- `--reconcile [cursor]`: apply the same bounded review, correcting a retained
  uncertain receipt only when the pinned journal has a definite accepted,
  rejected or retryable result for its exact original scope. A retryable journal
  result proves refusal of that submission; reconciliation marks the terminal
  receipt stopped and does not requeue it or recreate its deleted payload.
- `--review-index [scan-cursor]` / `--index [scan-cursor]`: dry-run/apply one bounded
  Redis SCAN page of retained receipts. Use these during a paused upgrade from a
  pre-index worker. Repeat using the returned cursor until `complete: true`;
  scans may repeat entries, and applying twice is safe. These commands only add
  monitoring pointers for this profile's uncertain receipts. Foreign profiles
  require their original configuration and an explicit cutover review.

Reconciliation handles a real lease-recovery race: a second worker can record
uncertainty while the first is awaiting SMTP, then the first can observe a definite
reply and persist it in the journal after losing its Redis completion lease.
The reviewed journal result is evidence for a receipt correction, not permission
to resend. Each correction atomically compares the exact old receipt, preserves
its original expiry/attempt count/history, appends a private source/outcome/time
record and removes only that hold pointer. Races leave the pointer for review;
a second successful apply is a no-op. Signed user status then reflects the corrected
accepted/stopped fact without exposing private journal identifiers or audit fields.

Uncertain/unknown journal results, corrupt/conflicting scopes, missing receipts
and unavailable journals remain held. These commands do not reconcile a rolled-back
backup, invent absent evidence, or supply SMTP bounce/complaint processing. Complete
the coordinated backup/MTA recovery and retention policy before activation. Pause
old schedulers during upgrade, account for all retained/expired and foreign-profile
holds, and verify both journal and queue monitoring; completing a scan alone is not
a complete historical-delivery audit. Pages are live views: restart inspection if
concurrent changes require a fresh inventory.
