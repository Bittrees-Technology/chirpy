# Native builds — macOS & iOS (Tauri 2)

Chirpy uses **Tauri 2**: the same Vite + React frontend is loaded into a native webview
on every platform. There is no separate native UI codebase — `apps/web/src` is the app,
and `apps/web/src-tauri` is the thin native shell.

## Why Tauri (not React Native)

Chirpy's chat is browser code — `@xmtp/browser-sdk`, `viem`, and WalletConnect v2. Tauri runs
that exact web frontend inside a native window/app, so Mac + iOS reuse it verbatim. React
Native would require swapping to a different XMTP SDK and rebuilding the UI — a rewrite. If we
ever want true-native widgets we can revisit, but Tauri is the lowest-risk path.

## Requirements

| Target | Needs |
|---|---|
| macOS desktop | Rust toolchain (`rustup`), Xcode **Command Line Tools** (clang) |
| iOS | Rust + **full Xcode** (App Store), an Apple Developer account for device/TestFlight, CocoaPods |

Install Rust once:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

## macOS desktop

```bash
pnpm tauri dev      # hot-reload dev window (runs `pnpm dev` for the frontend)
pnpm tauri build    # → apps/web/src-tauri/target/release/bundle/macos/Chirpy.app  (+ .dmg)
```

The first build compiles the Tauri/Rust dependency graph and takes several minutes;
later builds are incremental. Unsigned local builds open via right-click → Open (Gatekeeper).
For distribution, set up Apple Developer ID signing + notarization in `tauri.conf.json`.

## iOS

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
pnpm tauri ios init       # generates apps/web/src-tauri/gen/apple (Xcode project)
pnpm tauri ios dev        # build + launch in the iOS Simulator
pnpm tauri ios build      # archive for device / TestFlight (needs signing)
```

`tauri ios init` creates the Xcode project under `src-tauri/gen/` (git-ignored). Open it in
Xcode to set the bundle identifier (`org.bittrees.chirpy`), signing team, and capabilities.

## iOS web-platform notes (XMTP in WKWebView)

The real transport relies on browser primitives inside WKWebView:
- **WebAssembly + WebCrypto** — used by the XMTP MLS client. Supported in WKWebView.
- **OPFS / IndexedDB** — XMTP's local message store. Verify OPFS availability on the target
  iOS version early; fall back to IndexedDB if needed.
- **WalletConnect / deep links** — mobile wallet connection uses WalletConnect v2; register
  the app's URL scheme so wallet round-trips return to Chirpy.

These matter when building with `VITE_TRANSPORT=xmtp`; verify them on-device early.

## Auto-updates (desktop)

The desktop app self-updates via the Tauri **updater** plugin: on launch (and from
**Settings → Software update**) it fetches a signed `latest.json`, and shows update availability. Installation and restart require explicit actions in Settings.

- **Manifest endpoint** (`tauri.conf.json` → `plugins.updater.endpoints`):
  `https://github.com/Bittrees-Technology/chirpy/releases/latest/download/latest.json`
- **Signature:** every build is signed with an ed25519 key. The **public** key is in
  `tauri.conf.json`; the **private** key is **never committed** (gitignored under
  `src-tauri/.tauri/`). Updates with a bad/missing signature are rejected.
- **Frontend glue:** `apps/web/src/update.ts` (`autoUpdateOnLaunch`, `runUpdate`,
  `relaunchApp`). All of it is a no-op on the web build and on mobile.

### Releasing an update

The release workflow prepares draft artifacts after validating matching UI/Cargo/Tauri versions, production XMTP and live web/gate/sync readiness. Set all three versions before creating the matching tag:

```bash
# also update apps/web/src-tauri/Cargo.toml and its lockfile before tagging:
git tag app-v0.1.1 && git push origin app-v0.1.1
```

One-time CI setup — add repo **Actions secrets**:
- `TAURI_SIGNING_PRIVATE_KEY` — contents of `src-tauri/.tauri/chirpy-updater.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the key password (empty for the current key)
- Required on macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

Repository variables: `VITE_API_ORIGIN` (defaults to the hosted Chirpy origin), `VITE_MAINNET_RPC_URL`, `VITE_WALLETCONNECT_PROJECT_ID`, `CHIRPY_GATE_HEALTH_URL`. Configure native sync/gate origins as described in [PRODUCTION.md](PRODUCTION.md). Missing credentials or unhealthy dependencies block preparation. Draft promotion requires verified signatures, clean installation and updater acceptance; Windows code signing and actual iOS/TestFlight acceptance remain outstanding.

Build + sign locally for testing:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat apps/web/src-tauri/.tauri/chirpy-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm tauri build            # emits the bundle + .sig + latest.json
```

### iOS / Android

App stores own updates on mobile — Apple disallows self-updating binaries. The updater
plugin is compiled out on mobile targets (`#[cfg(desktop)]` in `src-tauri/src/lib.rs`),
and the in-app UI shows "managed by the App Store." Ship iOS updates via TestFlight / the
App Store; the web build updates on reload.


## Validation status

CI checks macOS/iOS Rust compilation, generates the Xcode project, builds an unsigned simulator archive, and installs/launches it with a return-URL registration smoke test. It checks the packaged identity, simulator target, executable and URL scheme, and retains a screenshot for review. These test builds use XMTP dev and an inert API origin; they are not release artifacts. The CSP-constrained browser flow exercises live XMTP dev messaging; it does not prove WKWebView storage, WalletConnect return or signed distribution on a real device. Rust requires at least 1.88. Seven native dependency warnings remain tracked in [the security baseline](security/native-baseline-2026-09-09.json); they are not suppressed.
