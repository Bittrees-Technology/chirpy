# Governance and Research integration acceptance

Chat is the selected standalone application on `chat.bittrees.org`. Keep existing Push rooms in their original protocol, with the same IDs, history and membership authority. Product naming is Chat; public member labels remain the member’s choice. Email integration, including verified wallet↔email routing, is required before public cutover and default Chirpy forwarding.

The early [PLAN.md](PLAN.md) and its shared-package proposal are historical. Sharing a wallet does not migrate Push records into XMTP, transfer an XMTP database or prove device/history continuity. No shared UI package, iframe authorization or consumer cutover is implied by the current implementation.

## Implemented migration foundations

| Area | Implemented | Remaining acceptance |
|---|---|---|
| Domains and wallet lifecycle | Chat and Chirpy serve the same app; canonical signed service identity is preserved; wallet/provider changes isolate sessions | Production WalletConnect domain configuration and physical-device return |
| Direct messages | XMTP transport, consent, receipts, bounded history and supported history-recovery request | Old/new-origin production inbox/history, groups, blocked consent, offline and multi-device continuity |
| Community rooms | Bounded source registries, original source-qualified Push IDs, independent wallet-bound runtime, history, member lists, supported EVM moderation, text/file/reply composition and bounded PNG/JPEG previews | Existing private-room/member/action parity, legacy identities, physical devices and remaining media/reaction/composite support; see [PUSH-INTEGRATION.md](PUSH-INTEGRATION.md) |
| Membership policy | Existing Push authority is preserved; unsupported legacy actions stay unavailable; separate XMTP gate supports reviewed token/Safe-owner/ENS rules | Real on-chain admission, live room roles and authoritative resolvers for unsupported role/power/delegate rules; never weaken a rule to obtain parity |
| Local data | Reviewed encrypted settings/contact/note/private-name export and restore; Governance source export | Research prerequisite integration/export deployment, actual cross-origin/device recovery and legacy deletion/conflict semantics |
| Email | Connected Mail pilot with inbox, conversations, sending/reply, scoped grants and bounded attachments | Both verified forwarding directions and remaining account/device/operational acceptance; see [CONNECTED-MAIL.md](CONNECTED-MAIL.md) |

Governance source inspection found ten private Push rooms; the approved Mail-test wallet has no membership there. Live room/history acceptance needs an authorized member or owner. The Research live registry was empty and the owner reported no known rooms; this is not proof that historical rooms never existed. Preserve discovery and legacy access. Research’s deployed registry changes and main branch must be reconciled before its dependent export and provider hardening are integrated; preserve existing drafts.

## Remaining execution order

1. Align the Research deployed registry change with its repository main, then integrate its dependent encrypted export and equivalent provider/session hardening after checks. Preserve current data and owner changes.
2. Complete source-room history, identity, membership and supported-action tests with an authorized existing member. A separate synthetic test room can validate real protocol delivery but cannot prove existing-room parity.
3. Verify encrypted source export/Chat restore and production XMTP history/consent on old and new origins and supported devices. Keep original messengers available until their data and authority acceptance passes.
4. Complete connected Mail acceptance and verified wallet↔email infrastructure, lifecycle/recovery and live delivery acceptance. Do not treat external mailto composition or a connected-mail pilot as completion of both bridges.
5. Review operator policies, native release requirements and the combined acceptance record. Switch consumer entry points only after acceptance and rollback verification, then enable safe Chirpy forwarding and finally rename repository/deployment labels. Preserve internal storage/signature/update identifiers.

Shared UI packaging or an iframe surface can be evaluated separately if required later. Framing stays denied by default. Any embed must validate exact parent origins, nested frames, wallet return, storage boundaries and message origin/source/schema. No wallet key, session key or arbitrary-signing bridge belongs in postMessage.

## Rollback and ownership

Rollback restores the prior consumer route/deployment while preserving both systems’ data. It cannot undo protocol membership changes, issued receipts, sync epochs or already decrypted messages. Retain prior deployments, room-ID mappings and registry snapshots with release evidence. Assign history retention, moderation, role-authority and cutover ownership before launch. [REMAINING-WORK.md](REMAINING-WORK.md) tracks open production dependencies; the local execution guide retains exact incremental deployment and test evidence.
