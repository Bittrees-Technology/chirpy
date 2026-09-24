# Resend API scheduler

The disabled-by-default supervisor entry point calls the existing Chat Resend
worker API. It does not contact Resend directly or hold provider, Redis, mailbox,
Wallet or SMTP credentials. The only secret it needs is the dedicated API worker
capability. The server keeps its existing consent, provider binding, single-job
claim, suppression, retry and idempotency checks.

Use Node24 and `selfhost/mail-api-scheduler.env.example`. `--once` requests one
tick, then checks private worker health. `--status` only requests health. Missing
enablement makes no request; disabled status and degraded health exit2. Transport,
configuration and malformed-response errors exit1 without printing remote bodies,
URLs or credentials. Network requests reject redirects and have sixty-second
timeouts; results are bounded and only validated counts/times/flags are printed.
An interrupted or failed observation does not prove that no message was sent.
Never reset receipts or generate another message ID to work around that outcome.

The existing `scripts/mail-worker.mjs [tick|status]` remains a manual command and
uses the same validation. A successful manual tick is not a delivery or health
assertion; operators must also inspect status.

Use `selfhost/install-mail-api-scheduler.py` for a first installation. It takes
a separately reviewed archive SHA256, copies and verifies a private snapshot,
checks every manifest file digest, and refuses existing accounts, installations,
unit overrides and activation links. A protected exclusive lock prevents concurrent
installation. It never runs the packaged runtime, starts a unit or enables the timer.
Before installing, review and pin the complete package, including a verified
Node24 runtime. Use the dedicated non-login `chat-mail-api-scheduler` account;
root owns the code/runtime under `/opt/chat-mail-api-scheduler`, and the private
environment under `/etc/chat-mail-api-scheduler`. No writable application state or
delivery journal is required. Keep environment0700 parent/0600 file, immutable
root-owned code and directory traversal for the dedicated account. The templates
deny writes to the system, home access, capabilities and privilege escalation.
Validate their effective isolation on the deployment host before enabling them.

The timer waits a minute after each completed invocation, without overlapping
oneshot jobs or catching up missed ticks. The service allows135seconds for the
two bounded requests plus cleanup. External health monitoring and alerts remain
required; a failed post-tick status does not undo a successful tick.
The current API processes at most one queued job per tick. This conservative
schedule is a pilot configuration; prove queue capacity and provider limits for
the expected launch volume before treating it as sufficient for production load.

Keep the already-installed local SMTP worker and its timer disabled. They have
different credentials, authority and journal contracts. Do not point their
loopback-only SMTP adapter at Resend or reuse their state as API delivery evidence.
Inventory and reconcile any existing jobs with their original provider binding
before a provider cutover; changing a setting never reauthorizes old jobs.

Prepare while both server admission and scheduler enablement are off. Complete
domain/credential/webhook enrollment, sender/reply mailbox, current Wallet
authority, approved live delivery/revocation/suppression, backup/recovery and
operator acceptance before enabling a supervised pilot. Public launch retains
the full Chat unification acceptance gates. Neither these templates nor passing
synthetic tests activate email, install a unit or prove production readiness.

## Reviewed installation package

The archive contains exactly these regular files, plus optional canonical parent
directories. Links, devices, extra files, duplicate paths and excessive sizes are
rejected. No dependency installation or package hooks are needed.

- `bundle.json`
- `runtime/bin/node` (the independently verified Linux Node24 executable)
- `selfhost/mail-api-scheduler.mjs`
- `selfhost/mail-api-scheduler.env.example`
- `selfhost/systemd/chat-mail-api-scheduler.service`
- `selfhost/systemd/chat-mail-api-scheduler.timer`

Use source bytes from one reviewed Git commit/tree. `bundle.json` has `version: 1`,
`component: "chat-mail-api-scheduler"`, the full `commit` and `tree`, and a `files`
object mapping each of the other five paths to its SHA256. These internal hashes
check consistency; the independently recorded whole-archive SHA256 establishes
the reviewed package. Record the installer SHA256 separately and invoke that
reviewed installer, not code extracted from the archive.

First run the installer with `--verify-only` and the reviewed `--sha256`; this
requires no administrator privileges and changes no host configuration. For
installation, invoke the same reviewed installer with Python isolated mode (`-I`)
as administrator, supplying the archive and `--sha256` but omitting `--verify-only`.
The source example must exactly match its disabled, empty-secret configuration.
Installation leaves a private receipt containing source provenance and file hashes;
code/runtime are root-owned and readable only by their dedicated service group.
No writable application state or mailbox/provider credentials are provisioned.

Do not retry a partial installation by removing its evidence. The installer refuses
all existing target paths and accounts; review and reconcile the failure first.
The lock file persists safely between runs. A successful install still requires
independent receipt/content/ownership checks, effective unit-policy checks and a
controlled disabled-service run on Acer before credential configuration or activation.
The hosted Linux suite performs the actual installation and refusal of a repeat,
then runs the disabled service and checks its kernel-enforced isolation. That is
installer acceptance on a disposable runner, not proof of Acer installation.
