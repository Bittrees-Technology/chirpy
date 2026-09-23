#!/usr/bin/env python3
"""Rebuild Chat's narrow XMTP consent patch from pinned upstream source.

Requires Rust 1.98.1 (wasm32-unknown-unknown target), wasm-bindgen 0.2.114,
Binaryen 125, a WASM-capable C compiler, Git and Cargo. Never publishes.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "013c00da7b399f99d7d507953dad7a1f1d7ef01e"
PATCH = ROOT / "patches/libxmtp-1.10.0-consent.patch"


def run(args, cwd, env, capture=False):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True) if capture else subprocess.check_call(args, cwd=cwd, env=env)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Reuse an exact already-patched checkout; its complete tracked diff is verified")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--tests-only", action="store_true", help="Verify the patch and run its native database regressions without packaging")
    parser.add_argument("--toolchain", default="1.98.1", help="Installed rustup toolchain name; its version must be 1.98.1")
    args = parser.parse_args()
    if not args.tests_only and args.output is None:
        parser.error("--output is required unless --tests-only is selected")
    env = dict(os.environ, RUSTUP_TOOLCHAIN=args.toolchain, CARGO_BUILD_JOBS="4", CARGO_PROFILE_TEST_DEBUG="0", CARGO_PROFILE_DEV_DEBUG="0", BINARYEN_CORES="4")
    versions = [(["rustc", "--version"], "rustc 1.98.1 ")]
    if not args.tests_only:
        versions += [(["wasm-bindgen", "--version"], "wasm-bindgen 0.2.114"), (["wasm-opt", "--version"], "wasm-opt version 125 ")]
    for command, expected in versions:
        version = run(command, ROOT, env, True).strip()
        if not version.startswith(expected):
            raise RuntimeError("Unexpected build tool: " + version)
    patch = PATCH.read_bytes()
    own_source = args.source is None
    source = args.source.resolve() if args.source else Path(tempfile.mkdtemp(prefix="chat-xmtp-build-"))
    if own_source:
        run(["git", "init", "--quiet", str(source)], ROOT, env)
        run(["git", "-C", str(source), "fetch", "--depth", "1", "https://github.com/xmtp/libxmtp.git", COMMIT], ROOT, env)
        run(["git", "checkout", "--detach", "FETCH_HEAD"], source, env)
        run(["git", "apply", str(PATCH)], source, env)
    if run(["git", "rev-parse", "HEAD"], source, env, True).strip() != COMMIT:
        raise RuntimeError("Source is not the pinned upstream commit")
    actual = subprocess.check_output(["git", "diff", "--binary", "HEAD"], cwd=source, env=env)
    if actual != patch:
        raise RuntimeError("Source changes differ from the reviewed patch")
    # Make compiler diagnostics in the shipped binary independent of user paths.
    env.pop("RUSTFLAGS", None)
    remaps = ["--remap-path-prefix=" + str(Path.home()) + "=/build-home", "--remap-path-prefix=" + str(source) + "=/libxmtp"]
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(["--cfg", "tracing_unstable", *remaps])
    env["CARGO_TARGET_DIR"] = str(source / "target")
    print("Building verified source in", source, flush=True)
    run(["cargo", "test", "--locked", "-p", "xmtp_db", "consent_record"], source, env)
    if args.tests_only:
        if own_source:
            shutil.rmtree(source)
        return
    env["CARGO_ENCODED_RUSTFLAGS"] += "\x1f" + "\x1f".join(["--cfg", 'getrandom_backend="wasm_js"', "-C", "target-feature=+bulk-memory,+mutable-globals"])
    run(["cargo", "build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "-p", "bindings_wasm"], source, env)
    # Only this new staging directory is cleaned. The caller's source is retained.
    with tempfile.TemporaryDirectory(prefix="chat-xmtp-package-") as temp:
        package = Path(temp) / "package"
        dist = package / "dist"
        dist.mkdir(parents=True)
        run(["wasm-bindgen", str(source / "target/wasm32-unknown-unknown/release/bindings_wasm.wasm"), "--target", "web", "--out-dir", str(dist), "--out-name", "bindings_wasm", "--remove-name-section"], source, env)
        wasm = dist / "bindings_wasm_bg.wasm"
        optimized = dist / "optimized.wasm"
        run(["wasm-opt", str(wasm), "-O", "--strip-debug", "--enable-bulk-memory", "--enable-reference-types", "--enable-multivalue", "--enable-sign-ext", "--enable-nontrapping-float-to-int", "-o", str(optimized)], source, env)
        optimized.replace(wasm)
        metadata = json.loads((source / "bindings/wasm/package.json").read_text())
        metadata.update(version="1.10.0-chat-consent.1", private=True)
        for key in ("scripts", "devDependencies", "publishConfig"):
            metadata.pop(key, None)
        (package / "package.json").write_text(json.dumps(metadata, indent=2) + "\n")
        shutil.copyfile(source / "bindings/wasm/LICENSE", package / "LICENSE")
        provenance = {"upstreamCommit": COMMIT, "patchSha256": digest(PATCH), "cargoLockSha256": digest(source / "Cargo.lock"), "rust": "1.98.1", "wasmBindgen": "0.2.114", "binaryen": "125", "files": {str(p.relative_to(package)): digest(p) for p in sorted(package.rglob("*")) if p.is_file()}}
        (package / "PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w") as archive:
            for path in sorted(package.rglob("*")):
                if not path.is_file():
                    continue
                info = archive.gettarinfo(str(path), "package/" + str(path.relative_to(package)))
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                with path.open("rb") as data:
                    archive.addfile(info, data)
        print("Built", output, "SHA-256", digest(output), flush=True)
    if own_source:
        shutil.rmtree(source)


if __name__ == "__main__":
    main()
