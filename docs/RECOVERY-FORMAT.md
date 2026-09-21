# Encrypted recovery format

This module is the foundation for application-data recovery. It does not yet expose export/import screens, collect browser storage, apply changes, or establish history continuity. Default domain forwarding remains disabled until the complete recovery and launch acceptance checks pass.

`apps/web/src/recoveryArchive.ts` accepts an explicit version-1 data object: source label, wallet address, creation time, contacts, saved notes, wallet-attributed blocks, and protocol/network-scoped read-receipt preferences. All fields are required; unsupported fields and duplicate record identifiers are rejected rather than discarded. Addresses are normalized to lowercase. Limits are 1,000 entries per collection, 50,000 characters per note, 512 KiB of UTF-8 payload and 704 KiB of file input. Callers must report limits and retain original data; silently truncating an export is unacceptable.

The envelope uses Web Crypto AES-256-GCM with a random 96-bit nonce, 128-bit authentication tag, random 128-bit salt and PBKDF2-HMAC-SHA-256 at 600,000 iterations. Version/algorithm/work-factor parameters are fixed and authenticated as additional data; unsupported parameters fail before derivation. The work factor follows [OWASP's PBKDF2 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Passwords must contain 12–1,024 characters and must not be only whitespace; callers should encourage a unique high-entropy passphrase. There is no password reset or server escrow. No wallet address, contact, note or preference is exposed outside encryption. A passphrase holder can construct another valid file: encryption does **not** authenticate its asserted source or prove wallet ownership.

Both functions are side-effect free with respect to storage and network. Password bytes and plaintext byte buffers are cleared where possible; JavaScript strings and garbage-collected copies cannot be reliably erased. Keys are non-extractable. The module neither exports nor accepts raw storage snapshots, private keys, reusable signatures, sessions, sync grants, XMTP databases, membership authority or email-forwarding consent.

## Caller contract for the following integration increment

- Independently prove the selected wallet's ownership and pass that wallet to decryption. A file's claimed address or a provider's account list alone is not proof. Recheck the active wallet and operation generation after asynchronous work, before presenting/applying results.
- Collect only explicitly supported application fields for that wallet. Legacy origin-wide preferences require explicit attribution before conversion. Unmapped receipt IDs must remain recoverable at their origin; never guess a network or conversation mapping.
- Preview the records and require explicit restore intent. Imported strings remain untrusted plain text. Receipt-sharing changes require review; no restored value may automatically enable sync, tracking, mailbox access or bridge forwarding.
- Define deterministic duplicate/conflict handling and durable recovery before changing local data. Preserve originals, distinguish quota failures from success, and handle wallet switching, interruption and retry. The codec performs no merge or deletion.
- Keep organization configuration, per-conversation read state, delivery receipts and actual protocol history under their separate validated migration contracts. They are not silently included by this format.
- Never put an archive, passphrase, signature or key in a URL, analytics event, log or unencrypted transfer channel. File handling must check size before reading. Recovery is incomplete until old/new-device and browser acceptance passes.

Focused tests exercise real encryption, Unicode and large-file round trips, randomized exports, tampered salt/nonce/ciphertext, wrong wallet/password, encrypted invalid payloads, unsupported KDF parameters, schema injection, ambiguous duplicates and resource bounds.
