# Email-to-wallet bridge implementation contract

Status: authenticated event/provenance contract and encrypted durable receiver implemented. Durable Mail source outbox and dedicated XMTP delivery worker remain unimplemented. The receiver is disabled by default; it creates no forwarding permission or signer. Wallet separately implements inbound consent and recipient resolution. No live bridging is enabled.

## Source event and authentication

Mail must produce events only for explicitly enrolled mailbox routes, with current mailbox assignment and Wallet inbound consent. Initial enrollment must not silently forward mailbox history. Every event carries exactly the version1 fields in `server/inbound-mail-contract.js`: fixed Mail source, deterministic ID, canonical mailbox, private binding reference/version, canonical mailbox message ID, whole-message source version, source-observed arrival time, From/Subject provenance, bounded plain text, truncation indicator and loop classification.

The event ID is SHA256 of compact JSON `["https://mail.bittrees.org",mailbox,messageId]`; it survives retries and must not change when a transport request is retried. The receiver rejects an arbitrary replacement ID. Wallet delivery IDs and content hashes are canonicalized by the module independently of transport timestamp or JSON property order. Changed content under the same delivery ID must conflict in the durable receiver, not become a new send.

Use independent random32byte source credentials, represented as64lowercase hex characters, never member wallet keys or the room gate key. HMAC-SHA256 signs the exact UTF8 request-body hash together with the fixed source, exact Chat `/api/mail-inbound` destination, protocol version and millisecond timestamp (see `signInboundMail`). The transport headers are `X-Chat-Mail-Timestamp` and `X-Chat-Mail-Signature`. Reject bodies above64KiB before buffering or parsing. Verify the HMAC before decoding JSON; reject invalid UTF8, unknown fields, stale timestamps (5minutes), excessive future skew (30seconds), stale arrivals (23hours), automated events and any nonzero bridge depth. Keep secrets out of logs. Fixed HTTPS endpoints must reject redirects.

The HMAC authenticates a Mail node, not the external From header. It does not replace mailbox ownership checks, separate per-direction consent or replay deduplication. An identical authenticated request may retry inside the timestamp window; the future durable queue must deduplicate by source/event ID and retain original content scope. Refreshing the transport timestamp must never extend event or delivery expiry.

## Content and delivery boundaries

Plain text is bounded to16KiB UTF8; From/Subject each to1000bytes with control and bidirectional override characters rejected. Truncation must be explicit. Do not render HTML or fetch links/media from the event. Mail's existing bounded MIME reader must pin sourceVersion and reject changed, ambiguous, symlinked or oversized originals. Envelope flags do not inspect MIME headers themselves: the authenticated producer must reject Chat bridge, auto-submitted and loop-prone messages before setting automated=false/bridgeDepth=0.

The text fallback explicitly identifies a Chat bridge message and unverified email provenance, includes a stable bridge reference and states that replying in Chat does not email the original author. Recipient wallet identity comes only from Wallet's authenticated inbound resolution, never From, To or text supplied by an email author. Preserve provenance as structured metadata for a future native Chat renderer as well as the fallback.

## Still required before activation

- Mail durable source outbox with fresh assignment/grant checks and canonical message/version references; the current five-minute notification queue is insufficient.
- Dispatch leases/retries, suppression/loop handling and fresh Wallet checks at every delivery attempt. The ingress queue is implemented below; no delivery worker runs yet.
- Dedicated, explicitly configured XMTP bridge identity and protected persistent SDK database, separate from member and gatekeeper keys; truthful queued/published/uncertain states.
- Crash-safe XMTP publication/reconciliation and revocation tests. Installed Node SDK6.0.0 exposes conversation-wide `publishMessages`, not selective publication through its public interface. Do not publish a conversation's pending batch unless every pending message remains authorized; an old revoked pending message must not ride along with a new one. Never infer an exception means nothing was sent.
- Source/worker hosting, credentials, enrollment, recipient support/retention/monitoring policy and approved real-account acceptance.

SDK interface reference: https://github.com/xmtp/xmtp-js/blob/main/sdks/node-sdk/src/Conversation.ts . The pinned installed version, rather than current main alone, must govern implementation and tests.

## Disabled durable receiver

`api/mail-inbound.js` preserves raw request bytes and accepts server POSTs only at the exact Chat endpoint. Browser Origin/Cookie requests, preview deployments, unconfigured services, invalid HMACs and non-allowlisted mailboxes are rejected. Configure only through the server secret manager using `selfhost/mail-inbound.env.example`; independent source HMAC, payload encryption and Wallet inbound credentials are required. No Resend or member-wallet key is needed by this receiver.

Before new queue insertion, Wallet must confirm the exact mailbox/binding/version, content hash and delivery ID and return a valid recipient wallet and fixed expiry. The queue encrypts the entire event, resolution scope and recipient with AES-256-GCM and the storage job key as authenticated context. Metadata contains only event ID, digest, pinned Wallet endpoint, status and timing. Neither plaintext email content nor recipient wallet appears in metadata. A future worker must preserve the pinned endpoint and scope and recheck both Mail source authority and Wallet consent before publication.

Redis atomically deduplicates by delivery ID and immutable content digest, checks the lesser of source-arrival and Wallet deadlines against its own clock, enforces a 1000-job queue cap and daily200/mailbox and1000/global pilot intake limits. Replays do not increase quota or refresh TTL. Changed content conflicts. Payload expires at the deadline (maximum23hours); status metadata remains30days. Worker cleanup must remove expired queue entries; configure no source intake until worker/monitoring acceptance prevents stranded mail. Lost insertion acknowledgements can retry the same event and recover the original receipt.

HTTP202/status queued means durable intake only, never XMTP publication/delivery/read. Failures return bounded errors without private transport details. Source outbox must retain rejected/transiently failing events and retry the same identity and content with a fresh transport timestamp; it must report expiry, limit, conflict and denial distinctly. The receiver exposes no public message/status lookup. A server-authenticated status/reconciliation path and user-visible progress remain worker-phase work.

## Outbound loop marker

New wallet-to-email jobs freeze `X-Chat-Bridge: wallet-to-email` in the encrypted provider payload. Mail’s inbound source rejects any `X-Chat-Bridge` occurrence before creating an inbound event. Retries preserve the exact original payload; existing jobs are not rewritten. Do not label a user-written message `Auto-Submitted: auto-generated`: RFC3834 section5.2 reserves that value for automatically generated content. The marker is a loop guard, not recipient authorization or a delivery receipt. Mail source also recognizes the existing Chat provenance text for older unmarked jobs; neither rule replaces fresh source and Wallet consent checks.
