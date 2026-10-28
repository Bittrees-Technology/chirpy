# Cold mail-worker Node upgrades

`selfhost/upgrade-mail-node.py` applies the pinned Node 24.22.1 security update to
Chat's isolated inbound worker and stateless API scheduler. It does not update
Wallet, Mail, the room gate, or the shared development runtime. Those installations
retain their own release owners. See the [official security release](https://nodejs.org/en/blog/release/v24.22.1/).

Prepare the Linux x64 candidate and license from the official archive, verify its
signed checksums against the Node release team's independently checked signing
key, and retain that evidence. This updater independently requires the exact
binary hash/size and license hash; it never downloads or executes an unverified
candidate. A Node version probe alone does not establish installed-worker health.

Before administrator execution, obtain the expected **base commit and exact
manifest hash** from the reviewed installation record, including accepted source
and dependency overlays. Do not adopt a digest from an unreviewed live bundle as
a source-authorization decision. Missing records or unexpected drift require
reconciliation before an update. The inbound worker must already contain the
reviewed Nodemailer 10.1.4 patch.

Run the reviewed updater with `--candidate`, `--license`,
`--expect-inbound-commit`, `--expect-inbound-manifest`,
`--expect-scheduler-commit` and `--expect-scheduler-manifest`. `--component` can
select `inbound`, `api-scheduler`, or the default `both`. Administrator input stays
local; never put passwords, provider keys or mailbox grants in the command.

The updater checks root ownership, complete installed file hashes, inactive
services, disabled timers/source socket, uniquely disabled environment flags,
installation locks, process inspection and storage reserve before changing files.
It refuses unavailable process inspection rather than treating it as no process.
For both components, every preflight finishes before either runtime is replaced.
Service-owned state is hashed and retained with its original ownership. The
inbound installer deliberately assigns `source.json` to the dedicated service
account with mode0400. The updater validates that exact owner, group, mode and
single regular-file link, and preserves its bytes and metadata. All other
configuration entries retain the root-ownership checks; scheduler files receive
no such exception. Settings snapshots are rechecked before replacement and after
the disabled runtime checks.
Missing temporary installation locks are created exclusively with mode0600 after
verifying root-protected parent directories. Existing lock files are never
replaced: unsafe ownership, permissions, links or concurrent holders stop the
update. A failed preflight may leave a new empty lock, but never licenses replay
of a durable attempt or partial package/runtime update.

It stages independently verified candidate bytes, records a durable attempt, and
moves each original binary into a protected backup alongside its original manifest
and the candidate license. It retains base release metadata and adds a runtime
overlay. It does not copy a whole release or use shared writable links. It imports
the existing inbound SDK without creating a client, and checks each disabled
command under its existing service account. It does not load production secrets
into those checks, restart a service, enable a schedule or send mail.

An interruption can leave a partial update. **Never rerun or automatically retry.**
Existing attempt/backup/candidate/receipt paths stop subsequent mutations. Preserve
all files and inspect both components under administrator authority before a
separately reviewed recovery action. A success receipt proves the checks reported
for that cold upgrade; it does not prove delivery, recovery promotion, continuous
monitoring or public launch readiness.

The disposable root-filesystem tests exercise refusal paths, source/manifest
authority, metadata, rollback preservation and no-replay behavior. They mock
systemd, service-account command results and free space. Linux runtime imports
and disabled-worker behavior are also covered by the isolated-runtime CI check;
actual installed-host checks remain necessary. No test is permission to activate
forwarding.

## Already-armed operator alerts

The two-component updater above deliberately excludes the notifier. Use the
separately reviewed `selfhost/upgrade-alert-node.py` for the original accepted
Chat operator-alert installation. Stage its exact companion
`upgrade-mail-node.py` beside it: the notifier updater verifies the companion's
source hash before loading only its filesystem/candidate primitives. Both
scripts and the operator launcher must be verified against the accepted release.
It takes `--candidate` and `--license` using the same pinned binary and license.

This update requires idle workers, disabled delivery timers, idle notifier
instances, the original reviewed notifier/unit bytes, the accepted activation
and provider-configuration receipts, and root-protected credentials. It refuses
unknown instances, software drift, unsafe state, unavailable process inspection,
or any prior upgrade attempt. Candidate and installed runtime must share a
filesystem for atomic replacement; rollback storage is checked separately even
when `/etc` and `/opt` use different filesystems. It preserves the armed configuration and failure
hooks; it does not stop, mask, restart or reload any service or invoke a failure
hook. The original test delivery state and all credentials stay intact.

The original executable is copied to an independent verified rollback file.
The verified candidate atomically replaces the existing path, so no missing
executable interval is introduced. An already-started process retains its old
inode; a newly started process opens the new runtime. Failure hooks remain armed
throughout. Concurrent activity detected during the checks holds the operation
for reconciliation; it never causes an automatic rollback or retry.

The new runtime is probed as the notifier's existing unprivileged account with a
minimal environment and sending explicitly disabled, without loading its real
environment file. A success receipt covers the runtime, preserved hooks, settings
and delivery state. It does not replace live notification acceptance or establish
that no unrelated service sent mail concurrently. Failed/interrupted operations
retain the original binary and durable attempt for operator review. Never rerun
on uncertainty. Root-filesystem fixtures mock systemd and command execution; an
actual host installation and disabled-runtime receipt are still required.
