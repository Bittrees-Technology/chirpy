# Encrypted sync format compatibility

The application upgrades encrypted settings to format2 when a user explicitly enables sync. Existing wallets keep their original encryption-key derivation and authorization signatures. The upgrade preserves legacy synchronized saved items and supports explicit deletion, unblock and receipt-reset markers. No background upgrade occurs before wallet authorization.

## Signed envelope and storage boundary

The existing device signature covers the complete blob and expected revision. The client sends the existing encrypted envelope (`version:1`, AES-GCM, HKDF-SHA-256, wallet address, IV, ciphertext and timestamp) with an additional signed `payloadVersion:2`. The API validates that envelope, canonical base64, wallet binding and size. It cannot validate encrypted plaintext; the client verifies the inner schema matches the outer marker. An unsigned request field cannot select or advance the format.

Legacy ciphertext stays in `chirpy:usersync:<wallet>`. A successful format2 write creates the permanent `chirpy:usersync:payload-v2:<wallet>` record. Once present, that record is authoritative and carries minimum format2. It has no expiry. Older deployed API handlers know only the legacy key; their later writes cannot replace the upgraded ciphertext or reset its minimum format. Legacy bytes are retained, not silently deleted or merged after upgrade.

One Redis transaction checks authorization epoch, device revocation, grant expiry using Redis time, exact prior storage bytes, expected revision and minimum format. A competing first upgrade or a concurrent legacy write forces a reread. Stale, invalid, expired or revoked requests cannot establish the upgraded slot. Subsequent old-format writes to the current API receive426; stale revisions may receive409 first. Revocation keys, canonical service identity, wallet signatures and encryption keys are unchanged.

GET advertises `payloadVersions:[1,2]` and `minPayloadVersion`; successful writes acknowledge the accepted minimum format. The upgrading client requires format2 capability before signing and require minimum2 in the acknowledgement, then reread the authoritative record. An older API acknowledgement is not proof of an upgrade. No data changes on reads. Unknown or corrupt upgraded records fail closed; the API never falls back to older data when the upgraded slot exists. Existing legacy records without revision metadata retain revision0 compatibility. Near-limit revisions remain exact because the transaction stores the API-serialized record without Lua JSON re-encoding.

## Rollout and recovery requirements

Deployment and rollback requirements:

- Preserve strict v2 encryption/decryption, deterministic delete/unblock markers, per-item conflict rules and arbitrary legacy saved-message fields.
- Rerun outer/inner version, unsupported-format, offline replay, account/session, competing-device and encrypted export/recovery acceptance when changing this path.
- Back up both storage slots with their revisions plus authorization epoch/revocation state. Do not reset the upgraded slot or import only the legacy key over it.
- Treat rollback to an API older than this safeguard as unsupported after any wallet upgrades: it exposes a separate stale legacy view. Keeping this API boundary during a frontend rollback protects the upgraded copy; older clients must pause instead of pretending their edits synchronized.
- Review retained legacy ciphertext against the operator's retention policy. No automatic deletion or retention promise is introduced here.

Validation uses real Redis transactions, including an old-handler legacy write after upgrade, concurrent modification between read and commit, expired upgrades, corrupted storage, permanent-key retention and exact large revisions. Isolated browser tests also exercise synthetic wallet/device signatures and actual encryption across two devices. Production-origin and physical-device acceptance remain separate launch requirements.

## Client model and encryption

`apps/web/src/versionedSync.ts` retains a timestamp on each preference, per-conversation receipt override, blocked-wallet entry and legacy saved-message entry. Explicit unblock (`false`), override reset (`null`) and saved-message deletion (`null`) remain in the payload, so replaying an older snapshot cannot resurrect them. Absent entries do not imply deletion. A later explicit action can recreate an entry. Equal-time conflicts keep receipts off, blocks on and message deletions; differing surviving message values use canonical JSON order. Merge is deterministic, idempotent, commutative and associative. Edits advance a safe logical timestamp even when the local clock moves backward. Unknown fields, corrupt records and exhausted size/clock limits stop processing rather than silently dropping data. Tombstones are not compacted.

`versionedSyncCipher.ts` accepts the existing derived AES key without changing wallet signatures or HKDF identities. Its v2 AES-GCM additional authenticated data binds the format, wallet and inner timestamp. It uses fresh random IVs and strict canonical encoding, schema and wire-size checks. Legacy encryption cannot be mislabeled as v2.

The legacy saved-message array is distinct from the XMTP Saved Messages self-conversation and from explicitly local contacts/notes. These helpers do not delete XMTP messages or upload the local library. The provider stores per-item metadata atomically with preferences, retains it through recovery/export/undo, requires API format capability before applying remote state, and verifies acknowledgement plus an authoritative reread. Never regenerate upgraded records from their materialized display view or reimport legacy state after upgrade.

## Guarded client transport

`versionedSyncTransport.ts` accepts only capability-advertising reads from the configured service. The caller supplies its persisted minimum format; minimum2 rejects a legacy or empty view. Validated snapshots are immutable, instance-bound read proofs with an exact revision, wallet, service and authorization epoch. Existing ciphertext must decrypt successfully before its snapshot can authorize replacement; there is no global/default write revision. Device grants and write signatures use the existing protocol, and the caller's current-wallet/session guard runs across asynchronous boundaries.

A format2 write must receive minimum2 and the exact next revision in its acknowledgement, followed by an authoritative format2 reread in the same epoch. A concurrent later record is returned for decryption/merge, never replaced with the submitted plaintext. Missing acknowledgements, network failures and incompatible rereads do not confirm synchronization; keep local data and reread before retrying. A409 is separately classified as a stale revision.

The real Redis integration runs the actual client encryption and existing wallet/device signature protocol: legacy decrypt/upgrade, saved-message deletion and unblock, acknowledged write/reread, stale compare-and-swap rejection, current old-format rejection and an immutable old handler writing the retained legacy slot. The upgraded record and deletion markers remain intact.

## Local migration, recovery and user controls

The wallet settings record contains its visible preferences, full `syncPayload` and a monotonic `syncMinimum`. Minimum1 records a prepared upgrade before the first potentially uncertain network write; minimum2 records authoritative upgraded data. A lost first acknowledgement preserves the prepared record and pauses sync. Re-enabling rereads and merges before retrying. Reload never persists device signing keys or restores authority automatically. Background reads and writes recheck wallet/provider, local revision, storage, authorization epoch and expiry. Disabling clears write authority immediately while retaining a separate closure solely to revoke that device.

Before remote upgrade, the client can merge the older encrypted local cache and honors legacy preference timestamps. Once the remote record is format2, an older local view cannot reintroduce saved items or stamp every stale preference as new. Differing receipt and legacy block preferences require an explicit choice to use the synchronized settings or keep this device's settings. Choosing local applies only those preferences as new intent. Existing encrypted local bytes remain intact; their saved items are never reimported into an upgraded remote record.

Previously synchronized legacy items are shown separately in Settings with a confirmed delete control. Legacy blocked-address preferences also have a scoped removal control; this does not change XMTP protocol consent. Local contacts/notes and the XMTP Saved Messages conversation are outside this encrypted-settings payload.

Encrypted recovery archive3 preserves all markers, the minimum format and an optional known private-name choice. Restore separately offers legacy-item/deletion-history import, receipt preferences and blocked addresses. Declining an import preserves existing metadata. Before/after/undo journals retain full data, and undo records explicit later intent while keeping sync off and the minimum format intact. Archive1/2 imports remain supported. Unknown or inconsistent records pause processing and preserve the original bytes.
