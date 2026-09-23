# Deployed Governance-to-Chat local recovery acceptance

Governance's connected-wallet Messenger page offers **Export local data to Chat** without requiring XMTP or Push activation. The same guarded export remains available after messaging is enabled. Governance PR24 removes the former dependency on an XMTP-ready inbox, which could strand contacts and local notes during migration.

The manually activated browser scenario in `tests/production-recovery/governance.spec.ts` uses the real deployed Governance and Chat applications. Two isolated Chromium contexts share a newly generated synthetic wallet, with no member account or existing browser storage. It seeds only synthetic Governance contacts, local notes and separately attributable shared preferences. It downloads the actual encrypted export and supplies that file to Chat's restore UI; no replacement exporter, mocked recovery component or simulated server response is used.

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
CHAT_EXPECTED_SHA=<full-reviewed-Chat-commit> \
GOV_EXPECTED_ASSET_SHA=<reviewed-Governance-main-module-SHA256> \
  pnpm exec playwright test --config playwright.production-recovery.config.ts
```

Both the config and test reject missing or malformed activation/version parameters. The runner checks Chat's live commit and the exact Governance main-module bytes before and after the scenario. The expected Governance hash should come from a verified deployment of the reviewed source, not an unexamined changing page. The test is excluded from normal CI discovery and has no automatic retries.

Browser network guards allow only GET/HEAD to each application's own origin. They block application writes, unrelated origins and messaging/RPC traffic. The injected wallet refuses transaction, messaging-registration, sync and profile signatures. Test keys and archive bytes remain in memory; traces and videos are off. Closing only the owned isolated contexts removes their temporary local stores and downloads. No production sync grants, mail grants or message-network identities are created; there is no server-side data cleanup to perform.

## Recorded result

Passed23September2026 against Chat commit `b2e7b3990e901f1851ef8ac1b8c60d95f9aae2b0` and Governance PR24 merge `cd33379f8f334c067a1f7a59c6bfc3248080e640`, deployed main module `/assets/index-aKWX5gSm.js`, SHA256 `a7c93ab359f4cd926e1a2d2dcaaa40a2448a81a09b76cb4b593343059a74a0d4`. All scenarios above passed with zero application network writes. Governance's separate full-app live test also passed default/shared exports without messaging activation.

This proves desktop Chromium migration of these local data classes. It does not prove XMTP message/group history, Push membership/content, contract-wallet or WalletConnect handoffs, physical/native devices, Research deployment, email authority or overall launch readiness. Original source access remains available. Apply the corresponding export-access fix to Research only after its deployment/main prerequisite is resolved.
