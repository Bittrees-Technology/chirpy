# Messaging channels: first-pass decisions

Status: recipient routing, external email composition, wallet invitation links and
an English/Spanish Channels view are implemented. Automatic email↔wallet delivery,
email sign-in and an in-app email inbox are **not implemented or activated**.
This is a staged start, not a production email service or a unified mailbox.

## Available routes

| Sender → recipient | Current behavior |
| --- | --- |
| Wallet → wallet / ENS | Existing XMTP direct chat and request/accept/block controls |
| Email → email | Recipient opens the user's email app using a single-recipient mailto link; the user chooses the email sender account |
| Email → wallet | Share a wallet invitation link in an email; recipient opens Chirpy and explicitly starts wallet chat. This is an invitation, not forwarding |
| Wallet → email | External email composition is available, but uses the email app's sender identity. Sending email authenticated as a wallet requires the bridge below |

Invitation format: `https://chirpy.bittrees.org/#to=<wallet-or-ENS>`.
The fragment is not sent to the web server. It remains visible to the browser,
page scripts and anyone given the link; it is not a secret. Only a single `to`
parameter is accepted; body, auto-send, email and duplicate recipient parameters
are rejected. Opening never signs, enables messaging, or sends. The recipient is
shown for confirmation. Standard HTTPS web invitations are implemented; native
OS universal-link registration and mail-app handoff acceptance remain untested.
Email composition supports a conservative single ASCII mailbox, not display-name
lists, internationalized addresses, attachments or arbitrary mailto headers.

## Recommended production configuration

1. **Identity:** independent verified email and wallet identities attached to a
   stable internal member ID. Linking requires proof of both identities, not a
   public address search. Linking does not merge historic conversations, Mercado
   quote ownership, staff roles or private-offer grants. Wallet-only members need
   no email. Email-only membership requires a separate authentication/onboarding
   implementation; no custodial wallet silently created for them.
2. **Transport:** XMTP production for wallet chat. Resend for email to align with
   Mercado's provider. Use a dedicated receiving subdomain, proposed
   `mail.chirpy.bittrees.org`, leaving existing business-email MX records intact.
   Configure provider domain verification, SPF/DKIM/DMARC and receiving MX through
   the authorized domain account. This document does not assert DNS is provisioned.
3. **Bridge:** one dedicated Chirpy service wallet, distinct from the room gatekeeper
   and Mercado operator identities. Run a single-writer persistent Node worker
   using the repository's pinned XMTP Node SDK and encrypted volume. Keep wallet
   and database keys in the host's secret manager; back up database and keys under
   separate access controls. Host selection and credentials are still required.
4. **Consent:** opt-in per direction and per correspondent. Default bridge off;
   no automatic fallback from blocked/failed wallet delivery to email. A versioned
   binding contains member ID, verified email, verified wallet, XMTP inbox/network,
   sender identity, consent timestamp and revocation state. Reverify the wallet's
   actual inbox server-side; `canMessage` is reachability, not recipient consent.
   Unlink, opt-out or inbox reassignment invalidates queued messages.
5. **Privacy:** visibly label bridged messages and the gateway sender. The gateway
   and email provider can read the email portion. Never label it end-to-end
   encrypted between the email user and wallet user. Use opaque, revocable,
   per-conversation reply aliases; do not encode public wallet addresses in a
   catch-all mailbox or expose a directory of email↔wallet associations.
6. **Delivery:** transactional outbox with unique event/recipient/binding-version,
   bounded leases, backoff, maximum five attempts and a 23-hour send TTL. Recheck
   consent/version before publishing. Store provider/XMTP identifiers and make
   accepted, delivered, failed and read separate states. Ambiguous sends require
   reconciliation; do not promise exactly-once XMTP delivery. Signed inbound
   webhook verification and durable event deduplication precede processing.
7. **Inbound trust:** provider signature proves webhook origin, not that the email
   From field owns a wallet. Require enrolled sender verification plus a scoped
   reply alias; reject unknown senders into a request/quarantine workflow. Add
   loop prevention, bounce/complaint suppression, sender/recipient quotas and
   abuse controls. Initial pilot: text only, 16 KiB body, no HTML rendering,
   remote content, attachments, payments or administrative commands.
8. **Retention:** proposed pilot defaults: purge forwarded body from the bridge
   after successful handoff; retain failed body encrypted at most 24 hours and
   content-free delivery metadata 30 days. Operator must align provider retention,
   privacy notice, deletion process and support ownership before enrollment.
   Removing a bridge copy cannot erase email or XMTP copies held by recipients.
9. **Mercado integration:** use generic referral/private-offer alerts with explicit
   subscriptions. Keep authorization and transaction acceptance in Mercado.
   Do not replace its new operations email outbox or reuse its operations recipient
   for customer messages. Group negotiations and full email-mailbox sync follow
   after direct-message bridge acceptance.

## Work required to activate automatic bridging

- Select/provision host and domain; install service secrets without putting them
  in source code or chat. Establish key backup and recovery ownership.
- Implement email onboarding, verified binding enrollment/revocation and private
  contact preferences. No public email→wallet lookup endpoint.
- Implement durable bridge schema, worker, signed receiving webhooks, provider
  status reconciliation, scoped reply aliases and authenticated message history.
- Extend conversation/message types and UI with channel, verified sender,
  subject/thread identity and delivery status. No fabricated bridge messages in
  the wallet inbox before an actual service exists.
- Test forged/replayed webhooks, From spoofing, alias guessing, looped replies,
  opt-out/unlink races, cross-account reads, failed/published-but-unacknowledged
  jobs, duplicates, expiration, quota exhaustion, provider outages, secret rotation,
  data deletion and restoration. Use synthetic consenting accounts first.
- Perform native mailto/universal-link checks and production deliverability tests;
  keep the broader gate/native/legal release blockers in REMAINING-WORK.md open.

Provider references:
- [Resend receiving](https://resend.com/docs/dashboard/receiving/introduction)
- [Resend webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
- [XMTP identity](https://xmtp.org/identity)
