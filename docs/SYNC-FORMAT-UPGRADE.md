# Encrypted sync format compatibility

The API supports a guarded future payload-format upgrade. The current client still writes format1; deletion/unblock tombstones and their client migration are not implemented by this prerequisite.

## Signed envelope and storage boundary

The existing device signature covers the complete blob and expected revision. A future client can send the existing encrypted envelope (`version:1`, AES-GCM, HKDF-SHA-256, wallet address, IV, ciphertext and timestamp) with an additional signed `payloadVersion:2`. The API validates that envelope, canonical base64, wallet binding and size. It cannot validate encrypted plaintext; the future client must verify the inner schema matches the outer marker. An unsigned request field cannot select or advance the format.

Legacy ciphertext stays in `chirpy:usersync:<wallet>`. A successful format2 write creates the permanent `chirpy:usersync:payload-v2:<wallet>` record. Once present, that record is authoritative and carries minimum format2. It has no expiry. Older deployed API handlers know only the legacy key; their later writes cannot replace the upgraded ciphertext or reset its minimum format. Legacy bytes are retained, not silently deleted or merged after upgrade.

One Redis transaction checks authorization epoch, device revocation, grant expiry using Redis time, exact prior storage bytes, expected revision and minimum format. A competing first upgrade or a concurrent legacy write forces a reread. Stale, invalid, expired or revoked requests cannot establish the upgraded slot. Subsequent old-format writes to the current API receive426; stale revisions may receive409 first. Revocation keys, canonical service identity, wallet signatures and encryption keys are unchanged.

GET advertises `payloadVersions:[1,2]` and `minPayloadVersion`; successful writes acknowledge the accepted minimum format. A future upgrading client must require format2 capability before signing and require minimum2 in the acknowledgement, then reread the authoritative record. An older API acknowledgement is not proof of an upgrade. No data changes on reads. Unknown or corrupt upgraded records fail closed; the API never falls back to older data when the upgraded slot exists. Existing legacy records without revision metadata retain revision0 compatibility. Near-limit revisions remain exact because the transaction stores the API-serialized record without Lua JSON re-encoding.

## Rollout and recovery requirements

Before enabling format2 in a client:

- Implement strict v2 encryption/decryption, deterministic delete/unblock tombstones, per-item conflict rules and preservation of arbitrary legacy saved-message fields.
- Verify current outer/inner version agreement, unsupported-format write pauses, offline replay, account changes, competing devices and encrypted export/recovery.
- Back up both storage slots with their revisions plus authorization epoch/revocation state. Do not reset the upgraded slot or import only the legacy key over it.
- Treat rollback to an API older than this safeguard as unsupported after any wallet upgrades: it exposes a separate stale legacy view. Keeping this API boundary during a frontend rollback protects the upgraded copy; older clients must pause instead of pretending their edits synchronized.
- Review retained legacy ciphertext against the operator's retention policy. No automatic deletion or retention promise is introduced here.

Validation uses real Redis transactions, including an old-handler legacy write after upgrade, concurrent modification between read and commit, expired upgrades, corrupted storage, permanent-key retention and exact large revisions. These tests do not replace the future client migration or actual multi-device production acceptance.
