# Operator delivery-service alerts

`mail-operator-alert.mjs` sends content-free failure notices independently to the
configured operator addresses. It accepts only the inbound worker, inbound health
check and Resend API scheduler service names, plus the explicit synthetic test unit. It never reads their journals,
message stores, wallet keys or worker credentials. It does not retry user messages.

The first deployment selects `admin@bittrees.io` and `raging@bittrees.org`, from
`chat@bittrees.org`. Keep `CHAT_MAIL_ALERTS_ENABLED=0` until the isolated host
installation, approved recipient checks and a bounded live alert have passed.
Provider acceptance is not proof that either operator received the email.

## Installation boundary

Install separately as a no-login `chat-mail-alerts` system account, with no extra
groups. Use a root-owned immutable `/opt/chat-mail-alerts` containing the reviewed
script and pinned Node24 runtime. Keep `/etc/chat-mail-alerts` root-owned0700 and
`alerts.env` root-owned0600; systemd loads the environment before dropping identity.
Use a sending-only Resend key restricted to the approved sender domain. Do not give
this account Wallet credentials, mailbox access, delivery-worker capabilities or
SDK custody. Set `/var/lib/chat-mail-alerts` to0700 owned by the alert account.

Install the supplied `chat-mail-alert@.service` template without starting it. Its
`flock` serializes each monitored unit's durable read/send/write cycle, including
manual retries. Do not invoke the script directly alongside its service. After
notifier acceptance, install `50-operator-alert.conf` separately into the `.d`
directories for the three explicitly reviewed system services. Never install it
as a global `service.d` hook or on the alert service itself. Reload units; enabling
these hooks must not enable any delivery timer. The existing user services remain
untouched. Check exact loaded units, user/groups, environment, file hashes and
private paths before allowing sends.

These templates are preparation, not an installer or host acceptance receipt.
The deployment checklist must record the applied runtime/configuration and actual
failure-hook/recipient acceptance before enabling delivery schedules.

## Retry and privacy behavior

Before its first send, the handler durably records a random alert ID, the fixed
observation time, hashes of both exact payloads, recipient-configuration scope and
one acceptance flag per recipient. Each recipient has a separate stable provider
idempotency key. A partial or uncertain response retries only the unaccepted
recipient, using the identical payload. No provider response body or error details
are printed. Network requests reject redirects, have15-second deadlines and limit
responses to8KiB. Local state is private, bounded, atomically replaced and fsynced.

Successful notices are suppressed for one hour per monitored unit. Another failure
after that interval can generate a reminder. Uncertain sends stop after23hours,
inside Resend's documented24-hour idempotency window. Changed recipients/sender,
changed payload text, corrupt state, unsafe permissions or clock rollback require
operator reconciliation. Preserve state rather than deleting it to force a retry.
The service retries failures after60seconds with a bounded systemd start limit;
review-required exit2 does not automatically restart. Future worker failures can
trigger another same-state retry within the allowed window.

## Remaining operational acceptance

After explicitly enabling the notifier for acceptance, start the supplied test unit once. Its intentional failure exercises the real hook with a `[Test]` subject and synthetic wording, without running a production worker. Verify both
inboxes and repeated-trigger suppression, then restore the test state deliberately.
Preserve the production alert state across upgrades; sender/recipient/template
changes need reconciliation for pending alerts. Backups must not be restored into
an active parallel sender or used to resend an already accepted alert.

These notices cover worker failures and degraded health, not individual customer
bounce notifications, recovery notices or a stopped timer that never executes.
Monitor alert-service failures, missed scheduler/health heartbeats and Acer/Resend
availability from an independent system before launch: an Acer-hosted Resend
notifier cannot report total Acer failure or a Resend outage over the same path.
Delivery schedules and public launch remain gated by that external monitoring and
live routing/recovery acceptance.

References: [systemd failure handlers](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)
and [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
