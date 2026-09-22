# Mail sender backup and recovery

The messaging database, SQLCipher salt, SQLite sidecars and delivery journal are
one recovery unit. Restoring an older journal can hide a message that was already
published. A valid checksum proves integrity, not that a backup is the latest or
that it is safe to resume sending.

## Capture

Use the installed Linux Node 24 runtime. Stop the inbound worker and health timers
and verify their processes have exited; also stop any manual sender processes.
Do not open the SDK independently during maintenance. The supported worker,
health command and snapshot capture use an exclusive `.operation-lock` directory
for their complete journal/child lifetime. Capture refuses existing ownership.
A killed process leaves its lock behind: no timeout, PID guess or restart clears it.

Choose a new canonical output path outside the live sender directory, under a
private parent directory (0700). The live sender must contain the provisioner's
`sender.json` matching that directory and journal identity.

```sh
/absolute/private/node selfhost/mail-inbound-snapshot.mjs capture \
  /absolute/private/sender --output /absolute/private/backups/new-snapshot
```

Capture copies the complete supported file set while holding exclusive ownership.
It rejects missing files, links, nonprivate entries, unexpected filenames, oversized
files and changes during copying. Each file is limited to 512 MiB and total state
to 2 GiB. The journal is checked only in an isolated disposable journal copy; no
XMTP client, network request, sync or message is made. The source is not checkpointed
or repaired by this command.

The first content in the output is `recovery-quarantine.json`. The copied sender
configuration is disabled. Journal construction and normal worker ownership refuse
quarantined directories even if someone changes the configuration to enabled.
Partial copies remain quarantined. A manifest is published last and hashes every
copied file, including disabled configuration, journal/WAL, SDK database/salt and
the quarantine marker. Capture reports whether the preserved journal is blocked.

Keep the printed manifest SHA-256 in a separately trusted recovery record. Record
the source release, XMTP network/identity, original canonical directory, capture
time, queue/source cutoffs, most recent successful backup and relevant operator
changes there. Never select a backup as current merely from its own timestamp.

The snapshot contains credentials and encryption keys as well as the encrypted
SDK database. **Use encrypted backup storage/archive and separately controlled key
custody.** This utility does not encrypt the entire snapshot. Do not upload it to
source control, logs, public storage or another runnable sender. Mail outbox state,
Wallet authority, queue state, environment credentials and offline wallet signing
custody require their own coordinated backup records; this snapshot does not
replace them.

## Verify a copy

```sh
/absolute/private/node selfhost/mail-inbound-snapshot.mjs verify \
  /absolute/private/backups/new-snapshot --manifest-sha256 TRUSTED_SHA256
```

Verification requires the independently retained manifest hash. It checks the
complete file inventory, hashes, private storage, original identity and copied
journal guard. It does not change the source or snapshot, load the SDK, clear an
uncertain attempt or grant a second launch. A blocked snapshot stays blocked.

## Recovery remains quarantined

There is deliberately no command to activate a backup or automatically replace
live state. Before restoring, fence and verify termination of every old sender,
source scheduler and duplicate installation. Keep the original state and all
newer evidence. Reconcile the snapshot against the latest queue/source history and
publication evidence; an empty local history or expired lease proves no absence
of publication. Review the exact original canonical path and identity: these are
bound into the journal fingerprint and cannot be silently relocated or changed.

An uncertain attempt requires positive, exact publication evidence. Do not clear
its guard, remove a launch claim, retry registration, run normal SDK sync, create a
blank journal, or pair an old journal with a newer SDK database. Quarantine and a
stale operation lock are operator review boundaries, not nuisance files to delete
on startup. Only after fencing, reconciliation, custody and live authority checks
may a reviewed recovery procedure remove quarantine and resume an installation.
Production recovery acceptance, encrypted backup custody and such operator
reconciliation remain required before launch.

## Development evidence

The disposable XMTP dev provisioning drill also captures/verifies a quarantined
backup, removes only its newly generated unused dev source, moves the backup to
that exact original path and verifies it again. Its explicit test-only recovery
removes quarantine, checks the restored journal, and reopens the identical SDK
installation without signing, re-registration, device sync or message publication.
It uses no production identity, member wallet or mailbox. Separate journal tests
prove published receipts, armed attempts and consumed launch claims survive a
copy, and that uncertainty cannot become a fresh send after restore.
