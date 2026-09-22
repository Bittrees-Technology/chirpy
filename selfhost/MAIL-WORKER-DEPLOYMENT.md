# Disabled Mail bridge installation

## Acer preparation, 22 September 2026

The dedicated Chat runtime and a separate Mail source-checker bundle are installed
under the `raging` account on Acer. Both forwarding flags and the Mail source
configuration are disabled. Worker and health services are loaded/inactive/static;
their timers are loaded/inactive/disabled. No service was started or enabled.

This records a prepared host, not production routing acceptance. No production
sender identity, credentials, enrollment, SDK client or message was created.

| Component | Installed source |
| --- | --- |
| Chat server/core/selfhost | `949a727b1d248a997f992a20ce8ba0d72d92e89a` |
| Mail source checker and imports | `d77ce17f9a8a6c73805005ab5a722b1beda40b41` |
| Private Node | `24.21.0`, official Linux x86-64 distribution |
| Host | Linux x86-64, glibc 2.39, Python 3.12.3, systemd 255 |

The runtime uses the committed worker dependency lock, installed without lifecycle
scripts and with separate empty npm configuration and cache. Dependency audit
reported zero vulnerabilities. Node's download matched its published checksum.

Artifact SHA256 values:

```text
Chat source tar: ce0c3c1801b2d4bf632d3bd1101fbac00cc680236e2b185196a60b46fb719946
Mail source tar: 46255a1e92b1cbc85151c909ca9411704b97e5fb65aa820d3f2a2ee02eccf39f
Node archive: fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
```

## Installed paths

All paths below are relative to the operator's home directory. The Chat runtime
and configuration roots are private (`0700`); configuration files are `0600`.

| Path | Purpose |
| --- | --- |
| `.local/share/chat/releases/<Chat commit>` | Exact committed source and isolated worker dependencies |
| `.local/share/chat/runtimes/node-v24.21.0-linux-x64` | Private Node; system Node remains 18.19.1 |
| `.local/share/chat/sources/<Mail commit>/ops` | Separate Python source-checker bundle |
| `.local/share/chat/app`, `runtime`, `mail-source` | Relative links to those exact versions |
| `.local/share/chat/deployment.json` | Source revisions, artifact hashes and disabled preparation record |
| `.config/chat/mail-inbound.env` | Disabled flags, blank credentials and explicit source/sender paths |
| `.config/chat/mail-source.json` | `{"enabled":false}` |
| `.config/systemd/user/chat-mail-inbound{,-health}.{service,timer}` | Four inactive unit definitions |

The source bundle contains `mail_chat_source_check.py`, `mail_chat_runner.py`,
`mail_chat_authority.py`, `mail_chat_inbound.py`, `mail_reply.py`, `mail_ai_read.py`
and `mail_managed.py`. It does not replace files in the existing Mail connector.
Configured source state is `.local/state/bittrees-mail-chat-inbound/outbox.sqlite`;
sender configuration is `.local/state/chat-mail-bridge/sender.json`.
Neither source outbox nor sender state directory existed after validation.
Do not pre-create the sender directory: provisioning requires a new absent path.

## Checks completed on the installed host

- Native SDK exports loaded with the private Node runtime, without creating a client.
- Disposable synthetic journal state retained its consumed launch across reopening.
  Concurrent ownership was refused; a captured backup remained quarantined and
  retained its unresolved-send guard. No native database was opened in this fixture.
- Worker `--once` returned disabled; `--status` returned disabled with exit 2.
  These checks were repeated at the final installed paths with the installed flags.
- Source runner `--check` and `--once` returned disabled. A synthetic source-check
  request returned unauthorized without creating the configured outbox.
- Unit syntax verified; all four unit definitions remained inactive and neither
  timer was enabled after the user manager reloaded its definitions.
- Existing `bittrees-mail-connector.service` remained active/running with zero
  restarts. Its code/configuration and the system Node installation were unchanged.

The new paths were created exclusively; installation refused existing targets.
Staging directories were promoted without replacement. Disposable test fixtures
were removed only by their exact owned paths. This single-host preparation does
not establish a reusable upgrade or rollback mechanism.

## Before any activation or removal

Resolve the production Wallet service host, dedicated sender identity and key
custody, encrypted backup destination, and monitoring recipient. Provision using
[the sender guide](MAIL-SENDER-PROVISIONING.md), then complete the
[joint recovery checks](MAIL-SENDER-RECOVERY.md). Configure separate credentials
and exact consent/enrollment; connected-mail grants alone do not authorize bridging.
Verify fresh source authority and both routing directions with approved test mail.

The installed source checker has only been tested disabled. Its enabled behavior
under the service filesystem restrictions still needs acceptance. Its read-only
configuration is separate from any future source-runner schedule; no source
schedule is installed here. The absent sender state also means these service
definitions are not yet ready to run with their protected writable path.

Keep public intake, sender and source enable flags off until the activation checks
pass. Do not interpret this installation as approval to launch or forward Chirpy.

For rollback of this preparation, first recheck that no worker/source has been
activated and no identity, journal, outbox or credentials have since been added.
If still unused, remove only the four recorded unit files and the two dedicated
Chat roots, then reload the user manager. Never remove the existing Mail connector
or its state. If state or authority exists, preserve it and use the recovery guide;
do not delete/recreate state or reclaim an operation lock as routine cleanup.
