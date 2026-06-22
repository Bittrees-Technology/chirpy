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
