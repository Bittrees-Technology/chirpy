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
Service-owned state is hashed and retained with its original ownership.

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
