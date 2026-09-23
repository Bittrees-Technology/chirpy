# Connected email attachments

The Email composer supports up to four files totaling 1 MiB. Files are selected explicitly, displayed by name and size, and removable before sending. Text and reply limits are unchanged. Files are held only in the current draft, cleared on refresh or exit, and not included in local recovery storage. Cancelled reads cannot repopulate a later draft.

The browser, Chat relay, Mail authority service and SMTP connector validate the attachment contract independently. SMTP receives binary files as application/octet-stream attachments. Mail encrypts larger queue payloads in private object storage; access is rechecked before dispatch. Deploy the Mail source and updated Acer connector with its outgoing-attachment helper before this composer.

A send snapshots the draft and reserves its request ID before dispatch. An uncertain send retains the existing Check Sent recovery flow and never automatically repeats. Source receipts bind file names and bytes as well as recipients, body and reply context. This does not enable wallet forwarding or change Mail grants.

Downloads request the complete file once, up to 1 MiB, instead of one queued request per 12 KiB chunk. Mail stores large encrypted responses briefly in private object storage with a job-bound encrypted pointer. Current grant authority is checked before and after reading the result; Chat verifies message version, file metadata, byte count and SHA-256 before saving. The progress display describes preparation and verification without inventing a percentage. Cancellation or a wallet change prevents a late result from downloading.

Deploy the updated Acer connector and attachment reader first, then Mail, then Chat. Older clients retain their existing chunk API. No automatic retry is added. Larger file support and native-device acceptance remain separate requirements; synthetic tests alone do not prove production delivery.

The updated client explicitly selects Mail transfer version 2 for message reads, HTML previews, attachment indexes, complete files and sends. It supports original MIME messages up to 2 MiB, with the existing preview limits. The relay preserves the 256 KiB contract for old clients. Mail v54 and the updated Acer readers were deployed before this opt-in. Invalid or downgraded version metadata fails closed; there is no silent retry through a different transfer contract.

Local hardening and isolated browser tests cover maximum-size selection, exact complete-file download, cancellation, grant loss and uncertain sends. A cross-source probe used the actual Python Mail reader, Chat downloader/preparer and Mail validator with a byte-exact 1 MiB synthetic file. These are fixture results: the approved live 256 KiB test remains the latest production round trip until a separately approved 1 MiB test completes. Files above 1 MiB and physical-device performance remain open.
