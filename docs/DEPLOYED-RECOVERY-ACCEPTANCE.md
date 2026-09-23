# Deployed Governance/Research-to-Chat local recovery acceptance

Governance's connected-wallet Messenger page offers **Export local data to Chat** without requiring XMTP or Push activation. The same guarded export remains available after messaging is enabled. Governance PR24 removes the former dependency on an XMTP-ready inbox, which could strand contacts and local notes during migration.

Research exposes the same wallet-owned export at `/chat-recovery`, independently of membership or messaging activation. Its original member messenger remains available under its existing rules.

The manually activated browser scenarios in `tests/production-recovery/local-data.spec.ts` use the real deployed source and Chat applications. Select `governance` (the backward-compatible default), `research`, or `all` using `CHAT_RECOVERY_SOURCE`. Two isolated Chromium contexts share a newly generated synthetic wallet, with no member account or existing browser storage. It seeds only synthetic source contacts, local notes and separately attributable shared preferences. It downloads the actual encrypted export and supplies that file to Chat's restore UI; no replacement exporter, mocked recovery component or simulated server response is used.

It verifies:

- Export before messaging activation, with fresh local-export ownership proof and unchanged source records.
- No unrelated storage in the decrypted archive; Push room pin/read keys are not reinterpreted as XMTP receipt preferences.
- Wrong-passphrase rejection without a recovery journal or data changes.
- Contacts and notes restored with receipts/legacy blocks initially unselected and sync still off.
- A decryptable pre-restore backup, successful undo, then a separate reviewed import with explicit receipt and legacy-block choices.
- The mobile restore review fits a390px viewport.
- No application network writes; every signature is a validated, origin/wallet/purpose-bound local recovery proof with a short expiry.

Run only after reviewing the deployed versions:

```sh
CHAT_PRODUCTION_RECOVERY_ACCEPTANCE=1 \
CHAT_RECOVERY_SOURCE=all \
CHAT_EXPECTED_SHA=<full-reviewed-Chat-commit> \
GOV_EXPECTED_ASSET_SHA=<reviewed-Governance-main-module-SHA256> \
RESEARCH_EXPECTED_ASSET_SHA=<reviewed-Research-main-module-SHA256> \
  pnpm exec playwright test --config playwright.production-recovery.config.ts
```

Both the config and test reject missing or malformed activation/version parameters, including unknown source selections or a missing hash for any selected source. Unselected source hashes are not required. The runner checks Chat's live commit and each selected source's exact main-module bytes before and after its scenario. Expected hashes must come from verified deployments of reviewed source, not an unexamined changing page. The test is excluded from normal CI discovery and has no automatic retries.

Browser network guards allow only GET/HEAD to each application's own origin. They block application writes, unrelated origins and messaging/RPC traffic. The injected wallet refuses transaction, messaging-registration, sync and profile signatures. Test keys and archive bytes remain in memory; traces and videos are off. Closing only the owned isolated contexts removes their temporary local stores and downloads. No production sync grants, mail grants or message-network identities are created; there is no server-side data cleanup to perform.

## Recorded result

Passed23September2026 against Chat commit `b2e7b3990e901f1851ef8ac1b8c60d95f9aae2b0` and Governance PR24 merge `cd33379f8f334c067a1f7a59c6bfc3248080e640`, deployed main module `/assets/index-aKWX5gSm.js`, SHA256 `a7c93ab359f4cd926e1a2d2dcaaa40a2448a81a09b76cb4b593343059a74a0d4`. All scenarios above passed with zero application network writes. Governance's separate full-app live test also passed default/shared exports without messaging activation.

This proves desktop Chromium migration of these local data classes. It does not prove XMTP message/group history, Push membership/content, contract-wallet or WalletConnect handoffs, physical/native devices, email authority or overall launch readiness. Original source access remains available. Research's former main/deployment alignment prerequisite was resolved in PR35, and its independent recovery entry was deployed in PR36; the shared runner now includes it.

The Research scenario was previously accepted against Research PR41 (`abd320d2c4fde849479623514e74af2e5925675e`), main module `/assets/index-xsUvFHFS.js` with SHA256 `6c705059fcda155df74fe195b58342fc4d4a53c126fab741ca5844614df0aa09`, and Chat `0cb294122303a30ad1a3693fd29981e137bb3d47`. This checked-in runner makes that acceptance reproducible alongside Governance; those historical hashes are evidence, not automatic defaults for future runs.

The combined runner passed both sources on23September2026 against Chat `0cb294122303a30ad1a3693fd29981e137bb3d47`, Governance PR28 (`4027da07ba8a10cc75acd2e8c4bb7e70377910a4`, asset SHA256 `ca946ae68d9f2bb6e63c9905e7d6c04a6cb4c2867f5ff33eb27b5a256de9c725`) and Research PR41 above. Both paths preserved the source, rejected an incorrect passphrase, restored with separate preferences, exported the pre-restore backup and undid the import, with zero application network writes.
