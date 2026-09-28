# Chat browser SDK recovery bridge

This private build uses the complete hash-pinned TypeScript sources from the published `@xmtp/browser-sdk@7.0.0` package. Its additive API forwards one encrypted invitation and expected conversation ID to the existing worker and installation. The reviewed paired WASM library authenticates the invitation, validates initial membership and refuses to replace existing group state. This SDK call does not send or resend a message.

`patches/xmtp-browser-7.0.0-welcome-recovery.patch` contains the source changes. The two worker URL suffix changes point the source-built bundle at its generated JavaScript workers. Source, metadata, license, patch, build tool lock and output hashes are recorded. Bundled JavaScript is compiled from those sources; it is not edited by hand.

Build with `python3 scripts/build-xmtp-browser.py --source /path/to/unmodified/browser-sdk-7.0.0/package --bindings /path/to/verified/recovery-bindings.tgz --output /path/to/sdk.tgz`. The unmodified source can be obtained from the published package; all source files, metadata and license must match the checked-in hashes. The builder uses an isolated temporary npm installation with scripts disabled, preserves failed builds for diagnosis, and never publishes. Verify the staged or installed artifact with `python3 scripts/verify-xmtp-browser.py [--installed]` and the paired bindings verifier.

The package retains version `7.0.0` for the existing dependency/override contract, marks itself private and adds `chatPatchRevision: 1`. Do not publish it as the upstream package. Review both private artifacts before changing either SDK or bindings.

Recovery is not automatic acceptance. The application must require an explicit selected conversation, sync it before exposing current membership/actions, preserve blocked or rejected consent, and report unavailable keys/history without resetting an installation or resending a message. Real browser recovery acceptance is still required before merging this increment.
