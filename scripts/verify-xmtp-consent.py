#!/usr/bin/env python3
"""Verify the reviewed local XMTP package, patch and pinned consumer contract."""
import hashlib
import sys
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor/xmtp-consent"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if sys.flags.optimize:
        raise RuntimeError("Run artifact verification without Python optimization")
    manifest = json.loads((VENDOR / "manifest.json").read_text())
    artifact = (VENDOR / manifest["artifact"]).resolve()
    assert artifact.parent == VENDOR.resolve(), "Artifact escaped vendor directory"
    assert artifact.stat().st_size < 8 * 1024 * 1024, "Unexpected archive size"
    assert sha(artifact.read_bytes()) == manifest["sha256"], "Archive checksum changed"
    expected = {"LICENSE", "package.json", "PROVENANCE.json", "dist/bindings_wasm.js", "dist/bindings_wasm.d.ts", "dist/bindings_wasm_bg.wasm", "dist/bindings_wasm_bg.wasm.d.ts"}
    with tarfile.open(artifact) as archive:
        members = archive.getmembers()
        assert len(members) == len(expected), "Unexpected archive member count"
        assert {m.name for m in members} == {"package/" + f for f in expected}, "Unexpected archive paths"
        assert all(m.isfile() and 0 <= m.size < 32 * 1024 * 1024 for m in members), "Invalid archive member"
        content = {m.name.removeprefix("package/"): archive.extractfile(m).read() for m in members}
    provenance = json.loads(content["PROVENANCE.json"])
    assert provenance["upstreamCommit"] == "013c00da7b399f99d7d507953dad7a1f1d7ef01e"
    assert provenance["patchSha256"] == sha((ROOT / "patches/libxmtp-1.10.0-consent.patch").read_bytes()), "Patch no longer matches build"
    assert provenance["cargoLockSha256"] == manifest["cargoLockSha256"]
    assert (provenance["rust"], provenance["wasmBindgen"], provenance["binaryen"]) == ("1.98.1", "0.2.114", "125")
    assert provenance["files"] == {name: sha(data) for name, data in content.items() if name != "PROVENANCE.json"}
    metadata = json.loads(content["package.json"])
    assert metadata["name"] == "@xmtp/wasm-bindings" and metadata["version"] == "1.10.0-chat-consent.1"
    assert metadata["private"] is True and "scripts" not in metadata
    wasm = content["dist/bindings_wasm_bg.wasm"]
    assert wasm[:8] == b"\x00asm\x01\x00\x00\x00" and sha(wasm) == manifest["wasmSha256"]
    assert b"/Users/" not in wasm and b"/home/runner/" not in wasm, "Unmapped builder paths"
    consumer = json.loads((ROOT / "packages/transport/package.json").read_text())
    assert consumer["dependencies"]["@xmtp/browser-sdk"] == "7.0.0", "Re-review patch compatibility before upgrading SDK"
    root = json.loads((ROOT / "package.json").read_text())
    assert root["pnpm"]["overrides"]["@xmtp/browser-sdk@7.0.0>@xmtp/wasm-bindings"] == "file:vendor/xmtp-consent/" + manifest["artifact"]
    if "--installed" in sys.argv:
        sdk = (ROOT / "packages/transport/node_modules/@xmtp/browser-sdk").resolve()
        installed = sdk.parent / "wasm-bindings"
        for name, expected_hash in provenance["files"].items():
            if name.startswith("dist/"):
                assert sha((installed / name).read_bytes()) == expected_hash, "Installed SDK differs from reviewed artifact"
    print("Verified pinned XMTP consent package, source patch, provenance and consumer.")


if __name__ == "__main__":
    main()
