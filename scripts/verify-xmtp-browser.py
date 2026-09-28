#!/usr/bin/env python3
"""Verify Chat's source-built SDK bridge and its paired private bindings."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor/xmtp-browser-recovery'
sha = lambda data: hashlib.sha256(data).hexdigest()

def main():
    if sys.flags.optimize:
        raise RuntimeError('Run verification without Python optimization')
    manifest = json.loads((VENDOR / 'manifest.json').read_text())
    artifact = (VENDOR / manifest['artifact']).resolve()
    assert artifact.parent == VENDOR.resolve()
    assert artifact.stat().st_size < 8 * 1024 * 1024
    assert sha(artifact.read_bytes()) == manifest['sha256']
    with tarfile.open(artifact) as archive:
        entries = archive.getmembers()
        assert 5 <= len(entries) <= 200
        assert len({m.name for m in entries}) == len(entries)
        assert all(m.isfile() and 0 <= m.size < 16 * 1024 * 1024 and m.name.startswith('package/') and '..' not in Path(m.name).parts for m in entries)
        files = {m.name.removeprefix('package/'): archive.extractfile(m).read() for m in entries}
    proof = json.loads(files['PROVENANCE.json'])
    assert proof['upstreamPackage'] == '@xmtp/browser-sdk@7.0.0'
    assert proof['files'] == {name: sha(data) for name, data in files.items() if name != 'PROVENANCE.json'}
    assert proof['sourceManifestSha256'] == sha((ROOT / 'patches/xmtp-browser-7.0.0-welcome-recovery-source.json').read_bytes())
    assert proof['sourcePatchSha256'] == sha((ROOT / 'patches/xmtp-browser-7.0.0-welcome-recovery.patch').read_bytes())
    assert proof['builderSha256'] == sha((ROOT / 'scripts/build-xmtp-browser.py').read_bytes())
    build = ROOT / 'scripts/xmtp-sdk-build'
    assert proof['buildLockSha256'] == sha((build / 'package-lock.json').read_bytes())
    assert proof['buildFiles'] == {name: sha((build / name).read_bytes()) for name in ['package.json', 'rollup.config.mjs', 'tsconfig.json']}
    bindings = json.loads((ROOT / 'vendor/xmtp-consent/manifest.json').read_text())
    assert proof['bindingsSha256'] == bindings['sha256']
    metadata = json.loads(files['package.json'])
    assert metadata['name'] == '@xmtp/browser-sdk' and metadata['version'] == '7.0.0'
    assert metadata['private'] is True and metadata['chatPatchRevision'] == 1 and 'scripts' not in metadata
    for name in ['dist/index.js', 'dist/index.d.ts', 'dist/workers/client.js']:
        assert b'recoverMissingWelcome' in files[name]
    root = json.loads((ROOT / 'package.json').read_text())
    assert root['pnpm']['overrides']['@xmtp/browser-sdk@7.0.0'] == 'file:vendor/xmtp-browser-recovery/' + manifest['artifact']
    if '--installed' in sys.argv:
        sdk = (ROOT / 'packages/transport/node_modules/@xmtp/browser-sdk').resolve()
        for name, digest in proof['files'].items():
            assert sha((sdk / name).read_bytes()) == digest, 'Installed SDK differs: ' + name
    print('Verified SDK recovery source, build inputs, artifact and binding pairing.')

if __name__ == '__main__':
    main()
