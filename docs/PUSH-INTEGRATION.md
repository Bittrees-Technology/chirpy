# Push integration status

Chat retains XMTP as its active messaging transport. The public Push registry adapter is a prerequisite for bringing Governance and Research rooms into the same app; it does not yet enable Push messaging.

`packages/transport/src/pushRegistry.ts` reads only the fixed public production registries, omits credentials, rejects redirects, and bounds response size and duration. A failed or unsupported registry rejects instead of returning an empty catalog. Consumers must preserve the previous catalog and show the failure. A successful empty registry is a distinct result.

Room identifiers retain the original Push chat ID inside a source-qualified `push:production:<source>:<chatId>` identifier. Existing XMTP IDs are unchanged. Duplicate IDs or keys and unsupported custom gate descriptors reject the catalog. Unassigned room configurations are not conversations.

Discovery is not admission. Built-in entries currently expose registry keys and no gate descriptor; a null descriptor must never mean public membership. Custom rules retain their source shape and must not be translated into Chat's illustrative organization gates. Joining, sending and moderation must use the original room's protocol authority.

Remaining integration work includes independent wallet-bound Push lifecycle and signing, session invalidation, history and reconnect, send states, membership and moderation, and conversation UI with accurate protocol capabilities. Do not remove legacy messenger access or enable launch forwarding based on this adapter. Live room-by-room and device acceptance remain required.

## Wallet session foundation

`PushRoomSession` binds one explicit enable action to one wallet address and provider. Callers must supply a live connection check and dispose the instance when its owner/provider or application scope changes. Provider account/chain/disconnect/session-delete events invalidate old facades, including disconnect/reconnect with the same account. Every SDK operation and signing/recovery request rechecks the actual account and chain before and after the request. Failed verification drops access. An already-dispatched SDK request cannot be cancelled; uncertain writes are never retried automatically.

The SDK is lazy-loaded in production mode. Recovered private keys stay internal to the SDK session; this app adds no browser key cache. Automatic SDK key upgrades are disabled. Legacy recovery is routed through a restricted provider wrapper for the selected wallet; arbitrary RPC requests and other account addresses are rejected. A checked-in pnpm patch makes the SDK construct its injected-wallet fallback lazily, so a supplied guarded provider works even without window.ethereum. The browser test covers both absent and unrelated injected wallets using synthetic V1 recovery. Original messenger/key recovery access must remain available. No cross-device/live recovery acceptance is claimed.

The session exposes guarded room operations, not SDK private keys or a general transaction signer. It is not yet wired to the Chat provider or conversation UI. The next increment must add source selection, independent connection states, lifecycle disposal, normalized history/send results, membership and protocol capability controls. Preserve XMTP IDs and behavior throughout.

SDK 1.7.32 uses older dependency ranges. Targeted overrides pin its Axios to 0.33.0 and UUID to 11.1.1; the isolated browser suite exercises the real SDK initializer with an intercepted synthetic registry, original cryptography, UUID generation, signer compatibility and selected-provider V1 recovery. Requests outside the fixture are blocked. OpenPGP resolves to patched 5.11.3. The scoped build polyfill plugin brings one low-severity `elliptic` advisory through `node-stdlib-browser`/`crypto-browserify`; the plugin's include list excludes the crypto polyfill. This build dependency still needs follow-up; the moderate-and-above audit remains enforced. These checks do not prove production protocol/device interoperability.
