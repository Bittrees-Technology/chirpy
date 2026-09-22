# Push integration status

Chat retains XMTP as its active messaging transport. The public Push registry adapter is a prerequisite for bringing Governance and Research rooms into the same app; it does not yet enable Push messaging.

`packages/transport/src/pushRegistry.ts` reads only the fixed public production registries, omits credentials, rejects redirects, and bounds response size and duration. A failed or unsupported registry rejects instead of returning an empty catalog. Consumers must preserve the previous catalog and show the failure. A successful empty registry is a distinct result.

Room identifiers retain the original Push chat ID inside a source-qualified `push:production:<source>:<chatId>` identifier. Existing XMTP IDs are unchanged. Duplicate IDs or keys and unsupported custom gate descriptors reject the catalog. Unassigned room configurations are not conversations.

Discovery is not admission. Built-in entries currently expose registry keys and no gate descriptor; a null descriptor must never mean public membership. Custom rules retain their source shape and must not be translated into Chat's illustrative organization gates. Joining, sending and moderation must use the original room's protocol authority.

Remaining integration work includes independent wallet-bound Push lifecycle and signing, session invalidation, history and reconnect, send states, membership and moderation, and conversation UI with accurate protocol capabilities. Do not remove legacy messenger access or enable launch forwarding based on this adapter. Live room-by-room and device acceptance remain required.
