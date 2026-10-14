# Connected Mail deployment preflight

Run `node scripts/connected-mail-preflight.mjs` in the deployment environment before changing connected-mail settings. Supply settings through the existing private environment mechanism, never command-line arguments. The command is offline: it neither contacts providers nor changes configuration, grants, flags or mail.

It reuses the runtime validator for the encryption key, KV configuration and acceptance wallet list. Exit 0 means that local configuration is valid, including when delivery is paused; exit 1 means invalid or missing configuration; exit 2 means unsupported arguments. JSON contains only booleans and missing variable names. Preview deployments remain blocked. The forwarding check, `scripts/mail-preflight.mjs`, is separate.

`enabled` reports whether the current runtime configuration permits connected Mail. `disconnectAvailable` reports whether its cleanup path remains configured even when disabled. `acceptanceAllowlistConfigured: false` means no acceptance wallet restriction was found in valid configuration; it is not launch approval. `contractWalletRpcConfigured` checks presence only, not endpoint validity, connectivity or contract-wallet compatibility.

This check cannot establish Mail source rollout flags, grant authority, actual KV/provider availability, background synchronization freshness, delivery, read-state behavior or device acceptance. Passing it never enables forwarding or satisfies combined production acceptance. Keep the completed and remaining evidence in [REMAINING-WORK.md](REMAINING-WORK.md).
