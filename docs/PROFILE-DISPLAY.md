# Profile display and publication

The product is Chat. Personal labels do not change the product brand.

Connected wallets can keep a device-local display name under `chat:walletProfile:v1:<lowercase-wallet>`. A saved empty name selects the shortened wallet address. Without a saved choice, the existing ENS name fallback remains; “Use ENS name” removes the local choice. Delayed ENS responses and reconnects respect saved choices. Storage failures reject the edit and show an error rather than claiming it was saved. Labels are bounded to 80 UTF-16 code units and reject control/directional override characters. Wallet choices do not inherit the local demo identity's name.

The profile card and sidebar prefer this choice. Looking up the wallet's ENS profile uses its address, not a freely entered name that could belong to another wallet. ENS avatars remain independently sourced from the connected wallet's resolved profile.

This is local presentation, not public publication, ENS ownership verification, or a change to the underlying wallet address. The settings screen says so explicitly. It does not send this preference to recipients or modify an ENS record. The encrypted recovery export includes this private choice, with an explicit unchecked restore option and retained backup/undo. It is not automatically synced across devices. The input retains a typing draft while identity displays committed values; failed saves restore the committed choice and show an error. Name edits use the same per-wallet Web Lock and pending-restore guard as recovery; queued edits are cancelled on wallet changes. Current tabs refresh after local recovery and cross-tab name changes.

Separate signed public-name publication and withdrawal are described in [Public profiles](PUBLIC-PROFILES.md). Restoring a private name never publishes or withdraws a public profile. Operator policy and device/transport acceptance remain release requirements. Clearing a published profile cannot erase copies already received by another person.
