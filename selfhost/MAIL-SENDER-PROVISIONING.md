# Dedicated inbound sender setup

This command is an operator bootstrap, not part of normal mailbox connection or
worker startup. It registers a new dedicated XMTP wallet. Do not run it until the
owner approves its network, custody, recovery and intended service identity.
Local and mocked tests do not prove live registration or delivery acceptance.

Use the verified private Linux Node 24 runtime. Prepare a private parent directory
(mode 0700) and a private JSON request file (0600), containing exactly:

```json
{
  "network": "dev",
  "directory": "/absolute/private/parent/sender",
  "identity": {
    "url": "https://approved-wallet-host/api/service/inbound",
    "credential": "THE-SEPARATE-INBOUND-SERVICE-CREDENTIAL"
  },
  "source": {
    "python": "/usr/bin/python3",
    "script": "/absolute/mail/mail_chat_source_check.py",
    "config": "/absolute/private/mail-source.json",
    "state": "/absolute/private/mail-source.sqlite"
  }
}
```

The destination must not exist. The parent must have a canonical absolute path;
resolve symlinks before preparing the request. The sibling `.sender.provision`
reservation must also be absent. Existing directories, partial setup, symbolic or
shared database files, unexpected database files and reused state are refused.
The request contains service credentials: never put it in source control, logs,
a browser, a URL or command arguments. The executable receives only its file path.

After approval, explicitly name the matching registration network:

```sh
/absolute/private/node selfhost/mail-inbound-provision.mjs \
  --config /absolute/private/request.json --register dev
```

Production requires a separately approved request and `--register production`.
The command generates new wallet and database keys, persists them in the private
reservation, and launches the fixed registration child with a minimal environment.
The child records an exclusive, durable launch claim before loading the SDK. It
creates only a fresh database, disables device sync, verifies the registered inbox
and installation, checks for an empty conversation list, returns identity details
without keys, and exits. It never sends a message, creates a conversation or syncs
an existing database. The child and supervisor each enforce bounded lifetimes.

The supervisor waits for process exit and closed pipes before handling database
files. It creates the final journal in a new directory, then moves the closed SDK
database, its required SQLCipher salt file and any WAL/shared-memory files together on the same filesystem. It
publishes `sender/sender.json` last, with `enabled:false`. The normal worker config
contains the database key but never the wallet signing key. Existing worker/source
flags and services are not modified or activated.

## Incomplete or interrupted setup

Preserve both the reservation and any final directory. Never remove files to retry,
rerun the registration child, create a blank journal over an existing database, or
open/sync the staging SDK database for investigation. A timeout can mean the network
registered the identity even if no result reached the supervisor. No automatic
resume or rollback is supported: review and reconcile the exact identity and all
state before a further operator-approved action. Partial installation has no
published enabled config, and the once-only reservation blocks another attempt.

## Custody and activation remain separate

`<parent>/.sender.provision/registration.json` retains the wallet signing key and
initial database key for owner custody. Move it to the approved offline custody
location and verify its backup/recovery before any activation; do not leave signing
material readable by the runtime service account. Do not duplicate runnable SDK
installations or restore an older journal alongside newer SDK state. The final
journal and SDK database form one recovery unit. Use the
[backup and recovery guide](MAIL-SENDER-RECOVERY.md) for exclusive capture,
quarantine and independently trusted integrity records. Uncertain message publication
requires positive publication evidence; normal sync is not a safe recovery probe.

Review the final sender configuration, separate worker/source credentials, mailbox
enrollment, service account filesystem restrictions, unit paths, monitoring and
alert destination. Then run approved live registration/routing and recovery tests.
Only after acceptance may the owner enable the sender and scheduled workers.

## Disposable development acceptance

The XMTP acceptance workflow opts into a fresh dev-only registration drill:

```sh
XMTP_MAIL_PROVISION_DRILL=1 node scripts/check-mail-worker-runtime.mjs
```

The default runtime check still creates no SDK client. The optional drill generates
a new disposable dev identity, installs its database and required salt/WAL files,
verifies the matching journal, then reopens the same installation in a separate
process with no wallet signer and auto-registration/device sync disabled. It checks
that no conversations exist and that repeated provisioning is refused. It never
sends a message or uses a member wallet, mailbox or production credential.
Successful disposable fixtures are removed; failures retain their private state
for investigation. This proves registration and database handoff, not production
custody, backup recovery, live authorization or delivery acceptance.

## Isolated Mail account

When Mail owns private mailbox files under a different account, configure `source` as exactly `{"socket":"/run/chat-mail-source/check.sock"}` instead of the four local-process paths. The operator must install a trusted local source checker behind that Unix socket, with a root-owned parent and socket access limited to Mail and the dedicated Chat account. The socket must accept one bounded JSON scope and return the existing source-authority response after rechecking Mail ownership, original Wallet consent and immutable event content. Chat never supplies file paths or receives mailbox contents through this interface. Do not activate until the actual Mail socket and permission/revocation checks pass.

Inactive Acer-oriented templates are in `systemd/mail-source/`. Before installing, verify the existing Mail account and exact source/configuration/outbox paths; install the reviewed Mail checker bundle root-owned in `/opt/bittrees-mail-source`. The socket directory must be root-owned, with no group/other write permission. The socket is0660 for Mail and the dedicated Chat group. The per-request service retains Mail ownership and mounts mailbox/configuration files read-only. Only the dedicated outbox-state directory is writable so SQLite can create its WAL/SHM companion files when opening the database with `mode=ro`; the checker still cannot modify records through that connection. The optional path prefix lets a disabled, not-yet-enrolled installation answer without an outbox directory. Keep this exception scoped to the exact private state directory, not the Mail home or Maildir. The service limits process lifetime and concurrent connections. It runs only the existing scope checker, never the source scanner or a send operation. Install neither over existing units or socket paths. Keep the socket disabled until source consent/configuration, deployed bundle integrity and real peer permission/timeout checks pass. Configure the separate Mail scanner under its existing Mail account; Chat does not own its outbox or Maildir.
