# Profile display and publication

The product is Chat. Personal labels do not change the product brand.

Connected wallets can keep a device-local display name under `chat:walletProfile:v1:<lowercase-wallet>`. A saved empty name selects the shortened wallet address. Without a saved choice, the existing ENS name fallback remains; “Use ENS name” removes the local choice. Delayed ENS responses and reconnects respect saved choices. Storage failures reject the edit and show an error rather than claiming it was saved. Labels are bounded to 80 UTF-16 code units and reject control/directional override characters. Wallet choices do not inherit the local demo identity's name.

The profile card and sidebar prefer this choice. Looking up the wallet's ENS profile uses its address, not a freely entered name that could belong to another wallet. ENS avatars remain independently sourced from the connected wallet's resolved profile.

This is local presentation, not public publication, ENS ownership verification, or a change to the underlying wallet address. The settings screen says so explicitly. It does not send this preference to recipients or modify an ENS record. These choices are not yet part of cross-device sync or the origin migration export.

Before launch, complete user-controlled public profile publication: an authenticated wallet-owned record, explicit opt-in for individual fields, bounded recipient-side validation and display, revocation/expiry and stale-cache handling, anti-impersonation provenance, and encrypted sync/origin recovery for the corresponding preferences. Review each transport separately; Push and XMTP profiles must not be assumed interchangeable. Clearing a published profile cannot erase copies already received by another person.
