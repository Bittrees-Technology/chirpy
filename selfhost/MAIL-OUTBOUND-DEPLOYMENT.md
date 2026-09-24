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
SMTP replies, credentials or wallet addresses. Health heartbeat alone does not
prove all historical uncertain submissions have been reconciled.

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
it does not connect, send, claim queue work or provision journal state. Local
`CHIRPY_MAIL_ENABLED=1` is needed to validate this complete configuration; keep
Vercel admission and `CHAT_MAIL_OUTBOUND_WORKER_ENABLED=0` during preparation.
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
for correlation, not recipient-side deduplication. Manual reconciliation and any
future receipt correction require authoritative MTA evidence; no reset/correction
API is supplied by this increment.

## Acceptance coverage

Tests use a private synthetic STARTTLS server, real Redis and SQLite. They cover
TLS/name/CA failures, plaintext downgrade rejection, bounded SMTP refusals,
acknowledgement loss, fresh Wallet/local authority and lease changes, lost Redis
completion, removed payloads, expiry/revocation, missing/replaced journals,
provider mismatch, stable MIME scope and content-free recovery. The journal suite
also kills a real child process after its durable boundary. No fixture sends an
external email. The isolated Linux runtime check verifies pinned dependencies and
disabled CLI behavior. Live sender, operational and public-launch gates remain open.
