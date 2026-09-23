# Connected email attachments

The Email composer supports up to four files totaling 256 KiB. Files are selected explicitly, displayed by name and size, and removable before sending. Text and reply limits are unchanged. Files are held only in the current draft, cleared on refresh or exit, and not included in local recovery storage. Cancelled reads cannot repopulate a later draft.

The browser, Chat relay, Mail authority service and SMTP connector validate the attachment contract independently. SMTP receives binary files as application/octet-stream attachments. Mail encrypts larger queue payloads in private object storage; access is rechecked before dispatch. Deploy the Mail source and updated Acer connector with its outgoing-attachment helper before this composer.

A send snapshots the draft and reserves its request ID before dispatch. An uncertain send retains the existing Check Sent recovery flow and never automatically repeats. Source receipts bind file names and bytes as well as recipients, body and reply context. This does not enable wallet forwarding or change Mail grants.

Larger file support, native-device acceptance and live production attachment delivery remain separate verification requirements. Synthetic tests do not prove those outcomes.
