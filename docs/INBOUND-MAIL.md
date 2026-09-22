# Email-to-wallet bridge implementation contract

Status: authenticated event/provenance contract implemented; receiver queue, durable Mail source outbox and dedicated XMTP delivery worker remain unimplemented. This module creates no route, worker, service identity, or forwarding permission. Wallet separately implements inbound consent and recipient resolution. No live bridging is enabled.

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
- Authenticated Chat ingress with encrypted durable storage, atomic immutable deduplication, bounded leases/retries, suppression/loop handling and live Wallet checks at dispatch.
- Dedicated, explicitly configured XMTP bridge identity and protected persistent SDK database, separate from member and gatekeeper keys; truthful queued/published/uncertain states.
- Crash-safe XMTP publication/reconciliation and revocation tests. Installed Node SDK6.0.0 exposes conversation-wide `publishMessages`, not selective publication through its public interface. Do not publish a conversation's pending batch unless every pending message remains authorized; an old revoked pending message must not ride along with a new one. Never infer an exception means nothing was sent.
- Source/worker hosting, credentials, enrollment, recipient support/retention/monitoring policy and approved real-account acceptance.

SDK interface reference: https://github.com/xmtp/xmtp-js/blob/main/sdks/node-sdk/src/Conversation.ts . The pinned installed version, rather than current main alone, must govern implementation and tests.
