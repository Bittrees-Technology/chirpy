# Release hardening — 14 October 2026

Main requires successful `test`, `gate-container`, `native-audit` and `xmtp-consent-storage` checks from GitHub Actions, with the branch up to date and conversations resolved. The restriction applies to administrators; force pushes and branch deletion are disabled. These four jobs run on every pull request. Path-filtered Apple jobs are not unconditional required contexts, because they do not run on documentation-only changes; Apple checks remain necessary for native release acceptance.

The native lockfile updates rustls 0.23.45 to 0.23.46, addressing RUSTSEC-2026-0346 through RUSTSEC-2026-0349. No audit exception was added. Local locked Cargo check and web production build passed; hosted native audit and Apple validation provide the remaining platform evidence.

## Remaining elliptic advisory

The installed dependency graph includes elliptic 6.6.1 through browserify-sign/create-ecdh, crypto-browserify, node-stdlib-browser and the Vite Node polyfill build plugin. The advisory has no published patched version. It remains visible in the dependency audit; the moderate-or-higher failure threshold is unchanged.

Chat configures only buffer, process, util, stream and events polyfills, not crypto. Inspection of the production build's emitted chunk module graph on this revision found no elliptic, crypto-browserify, browserify-sign or create-ecdh modules. This bounds observed web runtime exposure; it does not establish that the dependency is secure or remove build-environment exposure. Reassess when dependencies or polyfill configuration change. Prefer upstream replacement over an incompatible cryptography override.

## Operational boundaries

These changes do not enable forwarding, create room authority or accept a native release. The Acer gate installation, live email/device acceptance, independent monitoring, standby fencing and recovery drills remain separate requirements. A standby must never start the bridge or gate identity concurrently with the primary.

## Validation runtime correction — 27 October

Native-policy browser tests now receive the canonical Tauri CSP from the owned Vite preview server when `CHIRPY_TEST_NATIVE_CSP=1`. This replaces asynchronous response rewriting in the common wallet fixtures, which could race reload/teardown. Existing native flows remain covered. An additional browser case checks the exact response header and an enforced external-script violation; native runs cannot reuse a preview with an unknown policy. The actual Tauri and Vercel policies are unchanged. The separate previous-build migration proxy is retained.

Development-only aliases resolve the existing buffer/global/process ESM shims from the web app for linked workspace packages. No new polyfills or packages are introduced; the obsolete forced `@xmtp/proto` optimization is removed. `node scripts/check-web-dev.mjs` transforms the affected workspace entry points without a browser, protocol client or listening port. A scoped isolated-browser read also exercised the real public SDK metadata API without client construction, signing or revocation. It does not establish user-profile/history continuity.

The before/after production build comparison produced 73 byte-identical outputs. These development and preview-test corrections do not change the deployed frontend or application API behavior. Live service, recovery, device and launch acceptance remain separate gates.

Hosted validation also found that both isolated Push harnesses merged the old static configuration. They now evaluate the callback with Vite’s environment and load as ESM. The development probe loads both harnesses for build and preview; the pinned polyfill’s ESM exports resolve relative to the web app even when another harness bundles its configuration. Local Push runtime and all67Push UI cases pass; all73production outputs remain byte-identical. A separate real XMTP-dev consent-recovery failure remains under investigation; its bounded archive diagnostic now preserves the error and uses the SDK’s numeric cutoff type. No recovery assertion is skipped or relaxed.
