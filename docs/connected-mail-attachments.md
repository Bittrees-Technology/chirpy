# Connected email attachments

The Email composer supports up to four files totaling 1 MiB. Files are selected explicitly, displayed by name and size, and removable before sending. Text and reply limits are unchanged. Files are held only in the current draft, cleared on refresh or exit, and not included in local recovery storage. Cancelled reads cannot repopulate a later draft.

The browser, Chat relay, Mail authority service and SMTP connector validate the attachment contract independently. SMTP receives binary files as application/octet-stream attachments. Mail encrypts larger queue payloads in private object storage; access is rechecked before dispatch. Deploy the Mail source and updated Acer connector with its outgoing-attachment helper before this composer.

A send snapshots the draft and reserves its request ID before dispatch. An uncertain send retains the existing Check Sent recovery flow and never automatically repeats. Source receipts bind file names and bytes as well as recipients, body and reply context. This does not enable wallet forwarding or change Mail grants.

Current downloads request a version 3 attachment index and transfer files in 256 KiB chunks, up to 1 MiB per file and 2 MiB per original MIME message. Chat retains completed bytes during the active download and retries only a failed transient chunk, at most twice. Reloading does not preserve partial downloads. Cancellation, authority failures, malformed responses and integrity failures do not trigger retries. Sends never retry automatically.

Every chunk is bound to the folder, message, source version and MIME part. Chat validates metadata, offsets, byte counts and consistent hashes, then verifies the whole-file SHA-256 before saving. Expiry, disconnect or a wallet change discards late results. Current source authority remains enforced by Mail. An index explicitly identifying the supported version 2 contract uses the complete-file path; malformed or unsupported metadata fails closed without silent downgrade.

Deploy the matching Acer reader first, then Mail, then Chat. Older clients retain their compatible APIs. Message reads, HTML previews and sends continue to select transfer version 2; attachment indexes and current chunk downloads select version 3. This distinction matters when diagnosing deployed versions.

Production acceptance on 14 October 2026 verified the approved account's existing synthetic 1 MiB attachment through the deployed version 3 path with an exact SHA-256 match. Local tests cover interrupted chunk recovery, cancellation, grant loss, identity/version/size rejection and uncertain sends. The live test does not establish physical-device performance, arbitrary mailbox compatibility or files above 1 MiB; those remain open.
