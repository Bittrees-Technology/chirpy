# Browser wallet selection

Chat discovers installed wallets through EIP-6963. Settings shows a selector when more than one provider is available; connecting requires an explicit choice. A lone provider retains the existing Connect wallet flow. A distinct legacy `window.ethereum` provider remains available as Browser wallet.

Only the selected provider drives account and disconnect events. Disconnect clears Chat's local connection preference and listeners; it does not claim to revoke the extension's own site permissions. Remove those in the wallet itself. Late connection or restore responses cannot replace a newer selection or undo a disconnect.

Chat remembers the selected provider's advertised reverse domain name and last account locally. On reload it uses `eth_accounts` without an approval prompt, restoring only a unique matching provider and matching account. Missing, ambiguous or changed accounts require explicit connection. Older connections without a provider preference retain the existing default-provider restore path and gain a preference after restoration. Discovery continues for extensions that announce after initial page load.

Provider names, domains and account lists are self-reported routing information, not authenticated identities. Protected operations continue to require their existing signatures and authorization checks. Chat bounds and validates announcement metadata, deduplicates UUIDs/provider objects and does not render extension-provided icons.

WalletConnect remains available. This change supports the existing Bittrees Wallet extension's discovery interface; it does not implement a replacement mobile pairing protocol or establish real extension/device acceptance. Automated fixtures exercise discovery, event isolation, restoration and stale responses. A real installed extension and physical-wallet acceptance remain separate release evidence.

Reference: https://eips.ethereum.org/EIPS/eip-6963
