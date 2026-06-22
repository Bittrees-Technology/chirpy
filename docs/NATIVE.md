# Native builds — macOS & iOS (Tauri 2)

Parley uses **Tauri 2**: the same Vite + React frontend is loaded into a native webview
on every platform. There is no separate native UI codebase — `apps/web/src` is the app,
and `apps/web/src-tauri` is the thin native shell.

## Why Tauri (not React Native)

The chat engine we are building from (Bittrees' `xmtp.ts` / `push.ts`) is browser code:
`@xmtp/browser-sdk`, `@pushprotocol/restapi`, wagmi/viem, RainbowKit. Tauri runs that exact
web frontend inside a native window/app, so Mac + iOS reuse it verbatim. React Native would
require swapping to a different XMTP SDK and rebuilding the UI — a rewrite. If we ever want
true-native widgets we can revisit, but Tauri is the lowest-risk path from the existing code.

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
pnpm tauri build    # → apps/web/src-tauri/target/release/bundle/macos/Parley.app  (+ .dmg)
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
Xcode to set the bundle identifier (`org.bittrees.parley`), signing team, and capabilities.

## iOS web-platform notes (for when XmtpTransport is wired)

The real transport relies on browser primitives inside WKWebView:
- **WebAssembly + WebCrypto** — used by the XMTP MLS client. Supported in WKWebView.
- **OPFS / IndexedDB** — XMTP's local message store. Verify OPFS availability on the target
  iOS version early; fall back to IndexedDB if needed.
- **WalletConnect / deep links** — mobile wallet connection uses WalletConnect v2; register
  the app's URL scheme so wallet round-trips return to Parley.

These are integration concerns for the XMTP phase, not the current mock build.

## Auto-updates (desktop)

The desktop app self-updates via the Tauri **updater** plugin: on launch (and from
**Settings → Software update**) it fetches a signed `latest.json`, and if a newer version
exists it downloads, verifies the signature, installs, and relaunches.

- **Manifest endpoint** (`tauri.conf.json` → `plugins.updater.endpoints`):
  `https://github.com/Bittrees-Technology/chat/releases/latest/download/latest.json`
- **Signature:** every build is signed with an ed25519 key. The **public** key is in
  `tauri.conf.json`; the **private** key is **never committed** (gitignored under
  `src-tauri/.tauri/`). Updates with a bad/missing signature are rejected.
- **Frontend glue:** `apps/web/src/update.ts` (`autoUpdateOnLaunch`, `runUpdate`,
  `relaunchApp`). All of it is a no-op on the web build and on mobile.

### Releasing an update

CI does it — `.github/workflows/release.yml` builds, signs, and publishes on a tag:

```bash
# bump version in apps/web/src-tauri/tauri.conf.json AND apps/web/src/app.config.ts, then:
git tag app-v0.1.1 && git push origin app-v0.1.1
```

One-time CI setup — add repo **Actions secrets**:
- `TAURI_SIGNING_PRIVATE_KEY` — contents of `src-tauri/.tauri/parley-updater.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the key password (empty for the current key)
- (optional) Apple notarization vars for Gatekeeper-clean downloads.

Build + sign locally instead:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat apps/web/src-tauri/.tauri/parley-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm tauri build            # emits the bundle + .sig + latest.json
```

### iOS / Android

App stores own updates on mobile — Apple disallows self-updating binaries. The updater
plugin is compiled out on mobile targets (`#[cfg(desktop)]` in `src-tauri/src/lib.rs`),
and the in-app UI shows "managed by the App Store." Ship iOS updates via TestFlight / the
App Store; the web build updates on reload.

