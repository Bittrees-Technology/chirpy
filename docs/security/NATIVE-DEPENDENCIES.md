# Native warning applicability

Reviewed 9 September 2026 against the Cargo lockfile identified in [the platform evidence](native-platforms-2026-09-09.json). This supplements [the unsuppressed audit baseline](native-baseline-2026-09-09.json). No dependency was upgraded or warning suppressed by this review.

| Warning group | macOS ARM64 | iOS ARM64 simulator | Windows x64 MSVC | Linux x64 GNU |
| --- | --- | --- | --- | --- |
| `glib` 0.18.5 safety advisory | Absent | Absent | Absent | Present |
| `proc-macro-error` 1.0.4 unmaintained | Absent | Absent | Absent | Present |
| Five `unic-*` 0.9.0 unmaintained crates | Present | Present | Present | Present |

“Present” means reachable in Cargo's default-feature dependency graph for that target, including build dependencies. It does not establish that an affected function is called or linked into a shipped binary. “Absent” applies only to the checked target/feature combination. This is not a platform security certification or a scan of OS frameworks.

## Follow-up by dependency

- **glib:** Linux depends on the 0.18 series through GTK3, GDK and WebKitGTK. The recorded advisory lists 0.20 or newer as patched, but changing only the lockfile cannot satisfy the current 0.18 dependency requirements. Track a compatible upstream Tauri/GTK migration or a reviewed backport. Linux release acceptance must explicitly address this warning; Apple/Windows validation does not resolve it.
- **proc-macro-error:** the checked Linux graph introduces it through `glib-macros` and `gtk3-macros`. This is a build-time maintenance dependency. Track replacement in those upstream macro crates alongside the GTK migration. Absence on the checked Apple/Windows graphs does not remove it from the repository audit.
- **unic-char-property, unic-char-range, unic-common, unic-ucd-ident, unic-ucd-version:** these enter through `urlpattern` 0.3.0 and `tauri-utils` 2.9.3 on every checked platform. The graph contains both runtime and build-time paths. Track the upstream URL-pattern Unicode dependency replacement; do not treat these as Linux-only or force incompatible versions locally.

## Reproduce after dependency changes

From the repository root, run the following for each target and each package in the JSON evidence:

```sh
cargo tree --manifest-path apps/web/src-tauri/Cargo.toml --locked \
  --target aarch64-apple-darwin -i glib --depth 4
```

Cargo exits successfully and reports “nothing to print” when the package is absent from that target's graph. An error, including a missing offline cache entry, is not evidence of absence. The review downloaded missing registry packages for the Windows/Linux graphs before repeating all queries successfully with `--offline`.

Rerun the required Cargo audit and this platform review after lockfile, target or feature changes. Keep the seven warnings visible until the dependency graph actually removes or fixes them. Container findings have a separate [baseline](container-baseline-2026-09-09.json) and remain open.
