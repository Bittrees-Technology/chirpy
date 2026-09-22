# Email-to-wallet bridge implementation contract

Status: authenticated event/provenance contract, encrypted receiver, durable send journal, dedicated XMTP sender and queue executor are implemented. Mail separately implements the source outbox and dispatch-time authority checker; Wallet implements inbound consent and recipient resolution. Live provisioning, deployment, recovery policy and acceptance remain incomplete. Receiver and worker are disabled by default; no live bridging is enabled.

## Source event and authentication

Mail must produce events only for explicitly enrolled mailbox routes, with current mailbox assignment and Wallet inbound consent. Initial enrollment must not silently forward mailbox history. Every event carries exactly the version1 fields in `server/inbound-mail-contract.js`: fixed Mail source, deterministic ID, canonical mailbox, private binding reference/version, canonical mailbox message ID, whole-message source version, source-observed arrival time, From/Subject provenance, bounded plain text, truncation indicator and loop classification.

The event ID is SHA256 of compact JSON `["https://mail.bittrees.org",mailbox,messageId]`; it survives retries and must not change when a transport request is retried. The receiver rejects an arbitrary replacement ID. Wallet delivery IDs and content hashes are canonicalized by the module independently of transport timestamp or JSON property order. Changed content under the same delivery ID must conflict in the durable receiver, not become a new send.

Use independent random32byte source credentials, represented as64lowercase hex characters, never member wallet keys or the room gate key. HMAC-SHA256 signs the exact UTF8 request-body hash together with the fixed source, exact Chat `/api/mail-inbound` destination, protocol version and millisecond timestamp (see `signInboundMail`). The transport headers are `X-Chat-Mail-Timestamp` and `X-Chat-Mail-Signature`. Reject bodies above64KiB before buffering or parsing. Verify the HMAC before decoding JSON; reject invalid UTF8, unknown fields, stale timestamps (5minutes), excessive future skew (30seconds), stale arrivals (23hours), automated events and any nonzero bridge depth. Keep secrets out of logs. Fixed HTTPS endpoints must reject redirects.

The HMAC authenticates a Mail node, not the external From header. It does not replace mailbox ownership checks, separate per-direction consent or replay deduplication. An identical authenticated request may retry inside the timestamp window; the durable queue deduplicates by source/event ID and retains original content scope. Refreshing the transport timestamp must never extend event or delivery expiry.

## Content and delivery boundaries

Plain text is bounded to16KiB UTF8; From/Subject each to1000bytes with control and bidirectional override characters rejected. Truncation must be explicit. Do not render HTML or fetch links/media from the event. Mail's existing bounded MIME reader must pin sourceVersion and reject changed, ambiguous, symlinked or oversized originals. Envelope flags do not inspect MIME headers themselves: the authenticated producer must reject Chat bridge, auto-submitted and loop-prone messages before setting automated=false/bridgeDepth=0.

The text fallback explicitly identifies a Chat bridge message and unverified email provenance, includes a stable bridge reference and states that replying in Chat does not email the original author. Recipient wallet identity comes only from Wallet's authenticated inbound resolution, never From, To or text supplied by an email author. Preserve provenance as structured metadata for a future native Chat renderer as well as the fallback.

## Still required before activation

- Deploy and enroll Mail’s durable source outbox with fresh assignment/grant checks and canonical message/version references; the five-minute notification queue is insufficient.
- Configure the source and delivery worker scheduler, then accept leases/retries, loop handling and fresh authority checks on real approved accounts. No live delivery worker runs yet.
- Dedicated, explicitly configured XMTP bridge identity and protected persistent SDK database, separate from member and gatekeeper keys; truthful queued/published/uncertain states.
- Proof-backed uncertain-publication recovery and live crash/revocation acceptance. Installed Node SDK6.0.0 exposes conversation-wide `publishMessages`, not selective publication through its public interface. Do not publish a conversation's pending batch unless every pending message remains authorized; an old revoked pending message must not ride along with a new one. Never infer an exception means nothing was sent.
- Source/worker hosting, credentials, enrollment, recipient support/retention/monitoring policy and approved real-account acceptance.

Pinned native publication reference: https://github.com/xmtp/libxmtp/blob/1481f4bfe05defa5df00a17b749471ff5072f4d8/crates/xmtp_mls/src/groups/mls_sync.rs . Installed Node SDK6.0.0/node-bindings1.10.0 and their pinned source govern implementation and tests.

## Disabled durable receiver

`api/mail-inbound.js` preserves raw request bytes and accepts server POSTs only at the exact Chat endpoint. Browser Origin/Cookie requests, preview deployments, unconfigured services, invalid HMACs and non-allowlisted mailboxes are rejected. Configure only through the server secret manager using `selfhost/mail-inbound.env.example`; independent source HMAC, payload encryption and Wallet inbound credentials are required. No Resend or member-wallet key is needed by this receiver.

Before new queue insertion, Wallet must confirm the exact mailbox/binding/version, content hash and delivery ID and return a valid recipient wallet and fixed expiry. The queue encrypts the entire event, resolution scope and recipient with AES-256-GCM and the storage job key as authenticated context. Metadata contains event ID, digest, pinned Wallet endpoint, status, claim/timing fields and a hash of any publication receipt. Neither plaintext email content nor recipient wallet appears in metadata. The worker preserves the pinned endpoint and scope and rechecks both Mail source authority and Wallet consent before publication.

Redis atomically deduplicates by delivery ID and immutable content digest, checks the lesser of source-arrival and Wallet deadlines against its own clock, enforces a 1000-job queue cap and daily200/mailbox and1000/global pilot intake limits. Replays do not increase quota or refresh TTL. Changed content conflicts. Payload expires at the deadline (maximum23hours); status metadata remains30days. Worker cleanup must remove expired queue entries; configure no source intake until worker/monitoring acceptance prevents stranded mail. Lost insertion acknowledgements can retry the same event and recover the original receipt.

HTTP202/status queued means durable intake only, never XMTP publication/delivery/read. Failures return bounded errors without private transport details. Source outbox must retain rejected/transiently failing events and retry the same identity and content with a fresh transport timestamp; it must report expiry, limit, conflict and denial distinctly. The receiver exposes no public message/status lookup. A server-authenticated status/reconciliation path and user-visible progress remain worker-phase work.

## Outbound loop marker

New wallet-to-email jobs freeze `X-Chat-Bridge: wallet-to-email` in the encrypted provider payload. Mail’s inbound source rejects any `X-Chat-Bridge` occurrence before creating an inbound event. Retries preserve the exact original payload; existing jobs are not rewritten. Do not label a user-written message `Auto-Submitted: auto-generated`: RFC3834 section5.2 reserves that value for automatically generated content. The marker is a loop guard, not recipient authorization or a delivery receipt. Mail source also recognizes the existing Chat provenance text for older unmarked jobs; neither rule replaces fresh source and Wallet consent checks.

## Durable pre-publication guard

`server/inbound-send-journal.js` is self-hosted Node24 code. It is not imported by
web handlers. `InboundSendJournal.provision` accepts only a newly created dedicated
private directory and a64hex identity fingerprint. Existing SDK data must never
receive a fresh empty journal. The fingerprint must bind the configured bridge
identity, network and SDK database location; the dedicated sender below verifies those actual values. Opening a missing, unsafe, corrupt, inconsistent or
wrong-identity journal fails closed rather than provisioning automatically.

`guardedInboundSend` atomically records one durable armed attempt before invoking
any callback that might initialize or use XMTP. SQLite FULL durability, write
transactions and a bridge-wide active event prevent concurrent sends. The scope
binds the immutable event ID/content hash, hashed recipient and rendered text hash.
A same-event retry with changed content/recipient/text conflicts. Exceptions,
process death, expiry and permission revocation never clear the guard. There is
no lease timeout that allows another SDK callback to proceed after uncertainty.

Only an exact verified publication receipt may complete the attempt. The
SDK adapter checks published delivery status, sender inbox, conversation,
message ID and exact text against the guarded scope before returning it. The
journal validates and durably stores that receipt; it is not a cryptographic or
SDK publication verifier itself. A committed receipt whose acknowledgement was
lost can be recovered without re-entering the callback. A completed event's
receipt is immutable. The guard does not expose an unsafe reset/clear operation.

Retain the journal together with its SDK database and keys in protected backups.
No automatic pruning/TTL is applied to attempts; agree retention and recovery
policy before activation. Uncertain work must remain quarantined until a separate
proof-backed reconciliation procedure is implemented. Never use conversation
sync as a read-only recovery step: pinned libxmtp1481f4b send_message and
sync_with_conn both publish queued intents. A new send may publish an older
revoked one even when publishMessages is not called explicitly.

This module implements the durable guard; the sender and queue executor below
use it. Controlled provisioning, approved uncertainty reconciliation and live
acceptance remain required. No SDK key/client, network connection,
source timer or forwarding capability is created by this module.

## Private source-check process adapter

`server/inbound-source-process.js` invokes the co-located Mail
`mail_chat_source_check.py` through an explicitly configured absolute Python path.
Set all four private worker settings: `CHAT_MAIL_SOURCE_PYTHON`,
`CHAT_MAIL_SOURCE_CHECK_SCRIPT`, `CHAT_MAIL_SOURCE_CONFIG`, and
`CHAT_MAIL_SOURCE_STATE`. There is no PATH search, shell expansion, message-supplied
command, remote URL or permissive fallback. Python ignores Python-specific
inherited environment and user site packages; the child receives only HOME, a
fixed system PATH and locale, not bridge keys or provider credentials.

The adapter sends only eventId and canonical contentHash on stdin. It caps stdout
and stderr at4KiB each, kills a hung checker after15seconds and rejects failed
processes, malformed JSON or invalid UTF8 without returning private output.
A denial must match the exact requested scope. A positive response must match
that scope and original source deadline and have a checkedAt no older than5seconds
or more than1second in the future. Expired source events do not start a process.
Positive responses are never cached. Call this before each publication attempt;
an exception is unavailable authority, not permission or proof of non-delivery.

The queue worker keeps this preflight outside any new send when the
bridge journal already contains an unresolved attempt. This adapter does not
start the worker, install Mail files, register a wallet or enable forwarding.


## Isolated sender process boundary

`server/inbound-sender-process.js` arms the durable journal before launching an
explicitly configured, trusted Node executable and sender script. The child gets
its private configuration path as an argument and the exact email, recipient,
provenance text and canonical scope on bounded stdin. No inherited Node options,
provider credentials or signing keys are passed. Deployment code supplies these
absolute paths; email content must never select an executable. POSIX is required.

The boundary accepts a scope-matched publication receipt only after the child
terminates successfully and all pipes close. Output is bounded to 4 KiB per
stream. A timeout (maximum 60 seconds), crash, invalid output or mismatched receipt
leaves the durable guard armed; no automatic retry launches a second sender.
Timeout/output failure kills the entire child process group, including a Mail
source-check subprocess, and waits for closure. A receipt printed before a hung
process exits is not success. Parent termination also leaves the durable guard
armed; operators must not reset it or reopen that SDK database as a recovery step.

The trusted sender executable described below checks live Mail source and the
pinned Wallet recipient, uses a dedicated SDK identity/database, verifies the exact
Published message and returns `{scope,receipt}` before terminating.
This process boundary does not itself verify SDK publication or enable a worker.
Worker deployment, provisioning, proof-backed recovery and live acceptance remain
launch requirements.


## Dedicated XMTP sender

`server/inbound-sender-child.js` is the trusted executable for the process boundary.
Its private configuration must be an absolute, regular, non-symlink file with no
group/other permissions, at most16KiB and `enabled: true` to run. It accepts bounded
JSON stdin only. Keep it disabled until provisioning, worker deployment and live
acceptance are complete. Do not invoke it as a manual retry command.

The configuration contains `network` (`dev` or `production`), the dedicated EOA
`address`, pinned64hex `inboxId` and `installationId`,32bytehex `databaseKey`,
absolute private `directory`, `source` (python/script/config/state from the source
process adapter), and `identity` (HTTPS `/api/service/inbound` url and dedicated
credential). No wallet private key is accepted or required at runtime. The existing
private `directory/xmtp.db3` must hold an explicitly pre-registered dedicated
installation. The journal in that same directory must use the fingerprint returned
by `inboundSenderIdentity(config)`; the fingerprint binds the network, address,
installation, inbox, directory, database-key hash and Wallet service URL. Do not copy
a member/gate database or replace a journal with blank state. Controlled initial
provisioning and backup/restore acceptance remain required.

Journal schema2 adds an atomic one-time child launch claim. Opening schema1 migrates
transactionally and marks all existing attempts consumed, preserving uncertainty
rather than granting another SDK launch. The child claims before importing/opening
the SDK; concurrent or repeated invocations cannot reopen an already-started attempt.
Only the supervising parent persists the publication receipt after child termination.

`publishInboundXmtp` uses `Client.build` with auto-registration and device sync
disabled; checks the actual inbox/installation; resolves the recipient wallet;
verifies the DM peer and two-member scope; and repeats live Mail source and pinned
Wallet recipient authorization after conversation preparation. It rejects changed
inbox mappings and retains the original deadline. One non-optimistic send is followed
by a local lookup verifying exact ID, conversation, sender, text, text content type,
application kind and Published status. It does not sync, publish pending messages
or retry to repair missing publication evidence. Published is not a read receipt.

Run the worker under a supervisor (use an init process in containers); the worker
parent must not be PID1, so orphan adoption cannot masquerade as its original parent.
The child has an independent55second hard lifetime, watches for parent loss and
terminates its process group on timeout or termination signals. It explicitly exits
after emitting a verified receipt so native SDK work cannot remain in a cached
client. Any failure returns a generic error and keeps the durable guard armed.

Tests use a controlled SDK adapter to exercise publication/authority failures and
real child processes for disabled/consumed launch rejection. These are not live
network acceptance. Worker deployment, approved dedicated installation, source
enrollment, host configuration and proof-backed uncertain-send recovery remain open.


## Queue execution and restart recovery

Run `node selfhost/mail-inbound-worker.mjs --once` under a non-PID1 supervisor
with Node24. It handles one due job and exits; no service/timer is installed or
started by this change. Both inbound configuration and
`CHAT_MAIL_INBOUND_WORKER_ENABLED=1` are required.
`CHAT_MAIL_SENDER_CONFIG` names the private sender configuration described above,
whose own `enabled` flag must also be true. The disabled path opens no journal and
contacts no storage or SDK. The worker always launches the repository's fixed child
entrypoint, using the same configured identity and source checks.

Redis claims are atomic, use server time and120second leases, and preserve the
original metadata/payload TTL. Claim tokens fence stale workers. Missing or foreign
queue references are removed from the queue without deleting unrelated keys.
One call scans at most50 candidate references and processes at most one valid job.
Repeated scheduled calls reclaim expired work without extending message retention.

Before decrypting or sending, the worker checks the local journal. An exact
published receipt repairs a lost queue write even when the payload has expired;
an armed attempt becomes uncertain without opening the SDK. Only a job with no
prior send may retry after transient authorization failure, with bounded exponential
backoff. Expired/denied/changed-scope/corrupt payloads stop before SDK launch. A fresh
claim/deadline check precedes the sender, which independently repeats authority
checks and enforces its durable one-time launch.

After sending, only durable publication evidence can mark the queue published.
Redis stores its hash, not message text, recipient wallet or conversation ID. Lost
finish acknowledgements and expired leases never clear the SDK guard or trigger
a resend. Published/stopped jobs discard encrypted payloads; uncertain jobs retain
only their original payload TTL and leave the durable guard intact. Metadata retains
its original30day expiry. No status claims recipient delivery/read.

The command emits bounded status/id/blocked fields without body/address/key data.
Exit2 means an uncertain/blocked sender needs attention; exit1 means worker/storage
unavailability. Preserve both journal and queue state on either outcome. Scheduler,
monitoring/alert destination, provisioning, recovery policy and live acceptance
remain required before activation. Never resolve uncertainty by deleting state or
resubmitting a fresh event ID.


## Worker health and inactive scheduler templates

`node selfhost/mail-inbound-worker.mjs --status` reports aggregate queue counts,
oldest age, last attempted/successful tick and sender guard state. It reads queue
metadata only, never email payloads or the SDK. It does not refresh the heartbeat,
claim jobs, clear a guard or alter Redis queue state. Opening the existing journal
still validates its identity/integrity and applies supported schema migration.
The status command exits2 when disabled or degraded and1 if state is unavailable;
only a healthy enabled worker exits0. A disabled monitor must not look healthy.

Each completed `--once` tick records its outcome with Redis server time. Failures,
blocked attempts and retries preserve the last successful tick; inspecting status
never makes an absent scheduler appear alive. Freshness and oldest queued age are
bounded to5minutes. Expired jobs, stale claims, corrupt/orphaned references, overflow
and unresolved guards degrade health. A matching active send lease is distinguished
from uncertainty after that lease expires. Scanning is bounded to1000queue entries.
Output contains status, counts and times, not body, mailbox, wallet, event IDs or keys.

`selfhost/systemd/chat-mail-inbound{,-health}.{service,timer}` are inactive user-unit
templates. Worker scheduling waits30seconds after the previous run finishes; health
checks run once a minute. The worker timeout is110seconds (less than its120second
queue lease), and service termination kills its control group. Both units use
private temporary storage, restrictive permissions, no new privileges and a
read-only filesystem except the dedicated bridge state directory.

Templates expect a private Node24 runtime at `%h/.local/share/chat/runtime/bin/node`,
source at `%h/.local/share/chat/app`, environment at `%h/.config/chat/mail-inbound.env`
and sender state at `%h/.local/state/chat-mail-bridge`. Match the sender configuration
and installation fingerprint to that directory. Do not replace the system Node
installation used by existing services. Verify the runtime, native SDK, source
checker access and supervisor restrictions on the chosen host before activation.

No units are installed/enabled and no alerts are sent by these templates. Connect
the approved failure/health alert handler before enabling the monitor. Alert
destination, isolated runtime installation, provisioning, backup/restore and live
acceptance remain external activation requirements.
