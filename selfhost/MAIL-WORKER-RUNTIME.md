# Chat mail worker runtime

The inbound worker needs Node 24 and the dedicated dependency lock in
`mail-worker.package.json` / `mail-worker.package-lock.json`. Do not overwrite the
monorepo's package manifests or replace a host's system Node installation.

Prepare a **new, isolated deployment directory** containing the committed
`server/`, `packages/core/` and `selfhost/` trees, preserving those paths. Copy the
worker manifests into that directory as `package.json` and `package-lock.json`.
Use its private Node 24 executable and install with:

```sh
npm ci --ignore-scripts --omit=dev --no-fund
npm audit --omit=dev --audit-level=moderate
```

Use explicit empty user/global npm configuration files and an isolated cache when
validating a host, so unrelated credentials and package-manager configuration are
not involved. Installation scripts are unnecessary for the pinned, bundled XMTP
native bindings. The lock pins Node SDK 6.0.0, node-bindings 1.10.0, viem 2.53.1,
svix 2.5.0 and ws 8.21.0. The worker does not need the frontend build dependencies.

From a Linux checkout using Node 24, run:

```sh
node scripts/check-mail-worker-runtime.mjs
```

The check builds an isolated runtime from committed source, installs/audits the
worker lock, loads the native SDK, verifies a synthetic journal's restart/launch
guard, and exercises the disabled worker commands. It creates no SDK client,
wallet identity or message. Cleanup deletes only its own temporary fixture.
CI runs this check separately from the monorepo and gate container checks.

## Verified host baseline

On 22 September 2026, temporary Acer validation passed with Linux x86-64,
glibc 2.39 and a private Node 24.21.0 runtime. The downloaded
`node-v24.21.0-linux-x64.tar.xz` matched Node's published SHA256:

```text
fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
```

The dependency install reported no vulnerabilities. Native loading, synthetic
SQLite restart guards and disabled `--once` / `--status` passed. The system Node
remained 18.19.1. This was temporary runtime validation, not a permanent install,
SDK registration, service activation or live delivery acceptance.

The current Mac Node binding is present but cannot load because its published
binary references an unavailable Nix libiconv path. Do not silently patch the
vendored binary or infer that browser/Tauri clients share this issue. Linux is the
verified bridge runtime target; other platforms require their own acceptance.

## Before activation

Install the verified runtime at the private path expected by the inactive service
templates, or update those templates to the reviewed deployment paths. Provision
the dedicated installation/journal, verify Mail source-checker access under the
service restrictions, configure the approved monitoring destination and complete
backup/recovery and live routing acceptance first. Keep all worker/source enable
flags off until those checks pass. Never reuse member/gatekeeper state or use this
runtime check against an existing bridge database.

## Connected-mail duration compatibility

Connected mailbox grants are separate from bridge enrollment. The relay accepts
fixed source expiry up to 30 days and explicit `expiresAt: null` for Until revoked.
It never upgrades an existing grant. A persistent connection has no Redis TTL;
finite grants retain a bounded TTL. Browser cookies use a rolling 400-day maximum
for Until revoked, refreshed on authenticated status/operations; browser data
clearing or cookie policies can still require reconnection. Mail checks source
revocation, logout, roles and MFA on every operation and queue dispatch. Fixed
expiry timers in the UI recheck daily to avoid the browser's ~24-day timer limit.
Deploy this compatibility before Mail exposes the longer-duration consent UI.
