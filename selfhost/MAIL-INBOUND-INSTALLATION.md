# Dedicated inbound service installation

`install-mail-inbound.py` performs a first installation only. It does not migrate the existing operator-owned preparation, grant mailbox access, register a wallet, generate keys, initialize a sender/outbox or enable schedules. Existing paths/accounts/system units and inherited systemd policy are refused. Preserve partial installations for review; do not remove state to force a retry.

## Reviewed package

Build on Linux with Node24 using the pinned `mail-worker.package-lock.json`, lifecycle scripts disabled, in private staging. Include exactly the reviewed Chat `server`, `packages/core`, `selfhost` and worker dependencies beneath `release/`. Copy worker package manifests to `release/package.json` and `release/package-lock.json`. Exclude npm `.bin` links; reject other links. Include the verified Node binary as `runtime/bin/node` and the separately reviewed Mail checker/import bundle beneath `source/`. Do not include any environment file, credentials or existing databases.

The system templates are in `selfhost/systemd/system/`; prior operator-user templates remain unchanged. The trusted archive SHA256 must be supplied separately from the archive. The `bundle.json` schema is:

```json
{"version":1,"component":"chat-mail-inbound","commit":"<40hex Chat commit>","tree":"<40hex Chat tree>","sourceCommit":"<40hex Mail commit>","files":{"<each regular path except bundle.json>":"<SHA256>"}}
```

Every regular file must appear exactly once in the manifest; all required runtime/checker/unit files must exist. Verification rejects tar links/devices/traversal/duplicates, excessive expansion, mismatched runtime manifests, incorrect component/source provenance and file hash mismatches. Package hashes establish reviewed bytes, not enabled-path acceptance.

Run verification without privileges first:

```sh
python3 selfhost/install-mail-inbound.py /private/reviewed-bundle.tar --sha256 REVIEWED_SHA256 --verify-only
```

After reviewing the package and host preflight, run the same pinned installer with administrator privileges, omitting `--verify-only`. It creates no-login `chat-mail-inbound`, root-owned code in `/opt/chat-mail-inbound`, configuration in `/etc/chat-mail-inbound`, and an empty private writable parent `/var/lib/chat-mail-inbound`. `worker.env` is root-only; disabled `source.json` is root-only (0600). The worker receives a private read-only copy through systemd `LoadCredential` at `/run/credentials/chat-mail-inbound.service/source.json`, satisfying Mail’s private-file policy. The final sender child path remains absent for exclusive provisioning. No packaged executable is run by the administrator installer.

## Acceptance before activation

The CI drill installs on a disposable Linux runner, verifies actual file ownership, repeat-install refusal and inactive timers, runs the real disabled worker, and probes kernel enforcement of home/config/code isolation and the intended writable state. Its Mail checker is a deliberately non-executable synthetic authority fixture; enabled source authority still requires live acceptance.

On Acer, retain the existing inactive user deployment until the separate system installation is verified; confirm both user timers remain disabled. Do not run the CI cleanup script on Acer. Configure independent Wallet inbound credentials and explicit mailbox consent/enrollment only after operator authorization. Complete dedicated production sender custody and joint database/journal recovery through `MAIL-SENDER-PROVISIONING.md` and `MAIL-SENDER-RECOVERY.md`. Validate the real source checker under the system unit restrictions. Connect the approved alert handler and complete live routing/revocation/loop/replay tests before enabling either timer. Installation alone never authorizes public intake or the Chat cutover.

The sender provisioning request must use that same runtime credential path as its source config. Registration validates the path without loading it; dispatch reads it inside the worker unit. The health unit never loads source credentials. Each worker invocation snapshots source configuration; stop the worker before replacing configuration, then start a new invocation. Wallet consent is still rechecked on dispatch. Existing installations need a reviewed configuration/unit update; never rerun the first-install-only installer over them.
