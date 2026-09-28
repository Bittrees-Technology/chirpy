# XMTP consent ordering and welcome reliability patches

Chat temporarily carries a narrow source patch to `@xmtp/wasm-bindings` 1.10.0,
used only by the pinned `@xmtp/browser-sdk` 7.0.0. The npm archive is private and
is installed from this repository. Its MIT license is retained in the archive.

Storage-preserving source baseline: [libxmtp at 013c00d](https://github.com/xmtp/libxmtp/tree/013c00da7b399f99d7d507953dad7a1f1d7ef01e).
The reviewed changes and regression tests are in
`patches/libxmtp-1.10.0-consent.patch`.

The upstream storage conflict paths update state without updating the consent
timestamp. Replaying a previous block can therefore undo a later unblock; an
older allow can likewise undo a newer block. Same-state updates also need to
advance the ordering boundary. The patch stores state and timestamp together
and applies received updates with one atomic, strictly-newer conditional upsert.
Equal timestamps retain the existing choice. Explicit local mutation behavior
and the existing timestamp-based conflict model otherwise remain unchanged.
Local same-state no-ops do not advance an unbroadcast timestamp; this prevents
an implicit Allowed from send() outranking a newer explicit block on another
device. Received same-state records still advance the ordering boundary.

A creator's welcome supplies an implicit default with the lowest precedence,
not a new explicit allow on every installation. Local group creation time is
the new installation's receive time, so it cannot date an original choice. This prevents a later welcome from
overriding an existing or subsequently imported explicit block.

When stitching duplicate DMs, the patch selects the newest stored choice and
copies its original timestamp. Upstream selected the oldest result and gave it
a fresh timestamp, which could promote a stale default over an explicit block.

The second package revision also backports upstream [PR3931](https://github.com/xmtp/libxmtp/pull/3931), merged as `28e994ccf2a12a73f28d200f85700ced578de0b7`. Ordered welcome batches stop at a retryable failure after the normal retries, so a later welcome cannot advance the durable cursor past it. Non-retryable failures still allow later welcomes to proceed. The upstream regression uses two real MLS welcomes and asserts that the later one never advances the cursor after the earlier retryable failure. This prevents future skips; it does not recover previously skipped welcomes or prove the cause of a particular missing conversation.

The consent and welcome-ordering patches do not alter cryptographic code,
network environment, group permissions, membership or migration SQL. Consent is a per-inbox preference, not group
removal. Restoring blocked-room history can leave the new installation inactive;
history availability and active membership must be handled separately in Chat.
Unupdated installations retain their old SDK behavior. Old records with an
incorrect timestamp cannot be reconstructed reliably from state alone; a new
explicit choice receives the corrected timestamp handling.

## Release baseline and interoperability

Revision 4 retains the source and OpenMLS storage format of the deployed private
browser builds and corrects their welcome-wrapper interoperability. The npm
publishing checkout used for earlier rebuilds was not the source of the official
release binary. Moving back to the release branch made fresh native bridge
messages readable but failed the existing-browser upgrade gate: OpenMLS storage
includes incompatible serialized extension variants. That replacement (revision
3) was never accepted for production.

The precise wrapper mismatch is the X-Wing HPKE suite code: the deployed native
release uses `0x004d`, while the earlier private browser uses hpke-rs 0.6's
reassigned `0x647a` under the same XMTP wrapper descriptor. Synthetic cross-version
probes derive identical public keys but fail authenticated decryption. Curve25519
controls pass. The adapter preserves the requested HPKE suite code while mapping
only the underlying KEM operation to the unchanged upstream libcrux provider.
It does not implement cryptographic primitives or alter stored MLS state.

Outgoing welcomes use the deployed release code. Incoming X-Wing welcomes try
that code first and then the earlier private-browser code; both attempts require
authenticated decryption of the welcome and supplied metadata. Malformed data,
wrong keys, and modified ciphertext must still fail. Earlier unupdated private
browsers cannot read new release-format welcomes and need this update; existing
conversation state is retained. The source tests include an independently
produced hpke-rs 0.4 release fixture and tamper rejection.

Required acceptance includes the actual pinned native bridge, reopening a browser
database from the prior deployed build with the same inbox and installation,
earlier history, and replies in that existing conversation. Keep the candidate
unmerged until all those checks pass. Do not reset user databases or treat a
fresh-client success as existing-installation acceptance.

Previously skipped welcomes and production pilot recovery remain separate from
new-message interoperability; replacing the library does not prove recovery.

## Review and rebuild

Run `python3 scripts/verify-xmtp-consent.py` to verify the archive, source patch,
provenance hashes, supported consumer version and absence of personal builder
paths. pnpm additionally verifies its locked archive integrity.

Rebuild prerequisites are Rust **1.98.1** with `wasm32-unknown-unknown`,
wasm-bindgen CLI **0.2.114**, Binaryen **125**, Git, Cargo, Python 3.9+ and a
WASM-capable Clang/LLVM toolchain. Set `CC_wasm32_unknown_unknown` and
`AR_wasm32_unknown_unknown` to Clang and llvm-ar where needed.

```sh
python3 scripts/build-xmtp-consent.py --output /tmp/chat-xmtp-rebuilt.tgz
```

The script fetches the exact commit, verifies its complete tracked diff against
the patch, runs the real SQLite consent and MLS welcome regressions, compiles with the upstream
locked dependencies, and packages generated bindings with per-file hashes and
source provenance. It remaps personal compiler paths and normalizes archive
timestamps and ownership. Toolchain/host differences may change generated bytes;
do not replace the reviewed artifact merely because a rebuild finished.
An existing exactly patched checkout can be reused with `--source`; the script
never publishes and does not modify the application dependency selection.

Before replacing this package, run the consent database regressions (including
all six replay orders for all 27 state sequences), type/build and browser/native
checks, and actual XMTP-dev consent, two-wallet messaging and installation
recovery acceptance. The stock SDK fails the three timestamp regressions.

Remove the override, local archive and patch only after a compatible upstream
release passes these regressions and live acceptance. Do not carry this override
silently onto a different browser SDK version.
