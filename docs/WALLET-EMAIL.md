# Wallet-authorized outbound email pilot

Implemented: a wallet-signed email composer in Channels, signed status queries,
a durable encrypted Redis outbox, Resend delivery worker and private verification
record import/revocation. Shipping this code **does not activate email sending**.
No real customer messages, credentials or verification records were created.

This is explicit outbound composition, not automatic copying of existing XMTP
messages. It needs neither a custodial member wallet nor a dedicated XMTP bot.
Wallet signatures authorize the server to send an email; they never transfer
funds or expose the member's private key. EOA wallets are supported; smart-contract
wallet signature verification is not part of this pilot.

## Deployment configuration

Use `selfhost/mail.env.example` as the configuration inventory. Set all values
through the deployment secret manager. Use a verified dedicated sender address,
a restricted Resend sending key, a separate 32-byte queue encryption key, an
independent worker secret and durable Redis. Do not reuse the room gate's keys.
The service identity must be the stable HTTPS `/api/mail` URL. Preview deployments
always remain disabled even if environment variables are inherited.

A separate machine is not required for the first outbound service: Vercel hosts
`/api/mail` and `/api/mail-worker`; an operator-controlled scheduler invokes
`node scripts/mail-worker.mjs` once per minute with the service URL and worker
secret supplied through its environment. One tick claims at most one message.
No scheduler is automatically installed by this change. Monitor backlog age and
increase safe tick frequency for higher volume; do not remove quotas to compensate.
The worker has a configured 60-second limit. On timeout the lease/retry rules apply.

Keep the deployed `CHIRPY_MAIL_ENABLED=0` until recipient verification, consent,
suppression operations, provider/domain configuration and synthetic delivery
acceptance are complete. Configure a small explicit `CHIRPY_MAIL_SENDERS` EOA
allowlist. Sender wallets are limited to 20 new requests per rolling 24-hour
counter window; recipients to 50 across all senders. Anonymous wallet creation
cannot bypass the sender allowlist. This is not a public bulk-mail relay.

## Verification boundary and wallet.bittrees.org

Recipient authorization is a **private, correspondent-specific permission**, not
an assertion supplied by the sending browser. An authoritative verifier must
prove email control and record that the recipient opted to receive mail from the
specific sender wallet. Linking a member's own email and wallet does not by itself
supply a different recipient's consent. A valid record contains:

- `wallet`: canonical lowercase sending EOA address.
- `email`: verified recipient, with original local-part case and lowercase domain.
- `verifiedAt`, `consentedAt`, `expiresAt`: Unix milliseconds; consent follows
  verification and must still be valid.
- `evidenceId`: private verification/consent audit receipt reference.
- `version`: generated afresh by the trusted importer; never chosen by the browser.
- `revoked`: explicit boolean; importing a new version invalidates old queued work.

For a supervised pilot, an authorized operator may import evidence from an actual
approved verification process using `node scripts/mail-binding.mjs import <private-record.json>`.
The importer **validates the record shape, not the underlying evidence**. It is
not an email verifier and must not be exposed as a public API. Never fabricate
verification timestamps or treat a support request as proof of mailbox control.
The script needs the local complete configuration (`CHIRPY_MAIL_ENABLED=1` in that
local environment) but does not change deployment variables or send email.
Use `revoke` with a private file containing the wallet/email pair to replace the
permission immediately. Remove expired audit records through the identity service's
retention policy; Redis bindings expire automatically at their specified expiry.

The proposed shared identity service at `wallet.bittrees.org` should eventually
own mailbox verification, proof of wallet control, consent receipts and revocation.
It should publish these narrow delivery grants to this private store or replace
the adapter with a separately authenticated service. Chirpy keeps message signatures,
queueing and delivery. Mercado keeps its own sessions, deal grants and staff roles.
There is no public email-to-wallet lookup, browser-accessible binding write, key
export path or automatic migration of app permissions in this implementation.

## Delivery and failure semantics

Each signature includes the service, action, sending wallet, request ID, recipient,
subject, text and five-minute authorization expiry. Email enqueueing is idempotent
for the same wallet/request/content, even when a retry uses a fresh signature.
Reusing an ID for different content fails. Status queries require a fresh signature
from the same wallet; IDs are not bearer credentials.

Redis atomically rechecks signature expiry using millisecond-precision server time,
as well as the binding version and shared quotas, while creating the
job and payload. AES-256-GCM encrypts the immutable provider payload with the job
key as authenticated context. Payload TTL is 24 hours. Metadata TTL is 30 days;
the queue index contains opaque job hashes and is cleared as the worker processes
missing/expired records. Only the request ID is saved in the browser for recovery;
email content is not written to local storage by the composer.

Workers claim a 60-second lease, recheck consent/version and the sender allowlist
before forwarding, and make at most five attempts with exponential delay capped
at 15 minutes. Sending stops 23 hours after enqueue, inside Resend's 24-hour
idempotency window. Retries reuse the exact provider payload and idempotency key,
including after a send succeeded but its acknowledgement was lost. The encryption
key must remain available throughout pending jobs; changing it cannot decrypt old
payloads and requires an operator recovery procedure.

`queued`, `sending`, `accepted`, `stopped` and `unknown` are distinct. Accepted means
provider acceptance, not delivery or reading. Stopped can be ambiguous after an
interrupted provider attempt: reconcile with provider records before resending.
Revocation stops queued work and later attempts; an in-flight email cannot be
recalled. The composer locks request content during retries and keeps the request
ID available for signed status checks after reload.

The email plainly identifies the authorizing wallet and the Chirpy service. It is
text-only, with a 120-character subject and 16 KiB body. No attachments, HTML,
remote previews, payments or administrative commands. Email replies are **not**
forwarded into XMTP. The gateway and email provider can read the message.

## Activation acceptance and remaining work

Completed automated coverage includes signature substitution/expiry, header
injection, cross-origin and worker authentication rejection, concurrent enqueue
and worker claims, changed-content replay, encrypted payloads, permission changes,
quotas, crash-after-publish retries, retry limits, expired jobs and wrong keys.
Browser tests cover signing, uncertain responses, stable retry IDs, recovery and
truthful provider-acceptance status. Real Redis is required for atomicity tests.

Still required before an operator activates the supervised pilot:

1. Approved verification/recipient-consent process and genuine records, secret
   custody, verified sender domain, provider access and a scheduled worker.
2. Synthetic deliverability and failure tests using explicitly consenting test
   accounts; backups, key rotation/recovery rehearsal, backlog/worker alerts and
   documented support ownership.
3. Provider bounce/complaint monitoring with immediate manual revocation for the
   pilot. Public enrollment requires automated signed event processing, durable
   suppression and self-service opt-out before removing the allowlist.
4. Approved retention/privacy notices and a recipient support/opt-out contact.
   Provider and recipient copies have separate lifetimes from the Chirpy queue.
5. Smart-contract wallet support, email-only signup/key export, inbound email to
   wallet, reply aliases, full email conversation history and native-device
   acceptance remain separate work.

Sources: [Resend send API](https://resend.com/docs/api-reference/emails/send-email),
[provider idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys),
[Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration).
