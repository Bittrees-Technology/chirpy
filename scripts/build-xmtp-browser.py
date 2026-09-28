#!/usr/bin/env python3
"""Build the SDK recovery bridge from hash-pinned published sources. Never publishes."""
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
BUILD = ROOT / 'scripts/xmtp-sdk-build'
PATCH = ROOT / 'patches/xmtp-browser-7.0.0-welcome-recovery.patch'
PINS = ROOT / 'patches/xmtp-browser-7.0.0-welcome-recovery-source.json'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, help='Unmodified published SDK package source, required when the installed SDK is already patched')
    parser.add_argument('--bindings', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    pins = json.loads(PINS.read_text())
    if sha(PATCH.read_bytes()) != pins['patchSha256']:
        raise RuntimeError('SDK source patch differs from reviewed hash')
    original = args.source.resolve() if args.source else (ROOT / 'packages/transport/node_modules/@xmtp/browser-sdk').resolve()
    if sha((original / 'package.json').read_bytes()) != pins['packageMetadataSha256'] or sha((original / 'LICENSE').read_bytes()) != pins['licenseSha256']:
        raise RuntimeError('SDK metadata or license differs from reviewed baseline')
    metadata = json.loads((original / 'package.json').read_text())
    if (metadata['name'], metadata['version']) != ('@xmtp/browser-sdk', '7.0.0'):
        raise RuntimeError('Unexpected SDK source version')
    sources = {p.relative_to(original).as_posix(): sha(p.read_bytes()) for p in (original / 'src').rglob('*.ts')}
    if sources != pins['sourceFiles']:
        raise RuntimeError('Installed SDK source does not match the complete reviewed baseline')
    expected = {'LICENSE', 'package.json', 'PROVENANCE.json', 'dist/bindings_wasm.js', 'dist/bindings_wasm.d.ts', 'dist/bindings_wasm_bg.wasm', 'dist/bindings_wasm_bg.wasm.d.ts'}
    with tarfile.open(args.bindings) as archive:
        entries = archive.getmembers()
        if len(entries) != len(expected) or {m.name for m in entries} != {'package/' + name for name in expected} or not all(m.isfile() and 0 <= m.size < 32 * 1024 * 1024 for m in entries):
            raise RuntimeError('Unexpected bindings archive contents')
        bindings = {m.name.removeprefix('package/'): archive.extractfile(m).read() for m in entries}
    proof = json.loads(bindings['PROVENANCE.json'])
    if proof['patchSha256'] != sha((ROOT / 'patches/libxmtp-1.10.0-consent.patch').read_bytes()) or proof['files'] != {name: sha(data) for name, data in bindings.items() if name != 'PROVENANCE.json'}:
        raise RuntimeError('Bindings source or contents differ from reviewed build')
    if json.loads(bindings['package.json'])['version'] != '1.10.0-chat-consent.5':
        raise RuntimeError('Recovery bindings revision required')
    stage = Path(tempfile.mkdtemp(prefix='chat-sdk-recovery-build-'))
    print('SDK build staging:', stage, flush=True)
    env = dict(os.environ, npm_config_userconfig=str(stage / '.npmrc'), npm_config_globalconfig=str(stage / '.globalnpmrc'), npm_config_cache=str(stage / '.npm-cache'))
    (stage / '.npmrc').write_text('')
    (stage / '.globalnpmrc').write_text('')
    for name in ['package.json', 'package-lock.json', 'rollup.config.mjs', 'tsconfig.json']:
        shutil.copyfile(BUILD / name, stage / name)
    shutil.copytree(original / 'src', stage / 'src')
    subprocess.run(['git', 'apply', '--check', str(PATCH)], cwd=stage, check=True)
    subprocess.run(['git', 'apply', str(PATCH)], cwd=stage, check=True)
    subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=stage, env=env, check=True)
    # Replace only the isolated build's stock bindings with the verified private archive.
    target = stage / 'node_modules/@xmtp/wasm-bindings'
    shutil.rmtree(target)
    for name, data in bindings.items():
        p = target / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    subprocess.run(['node', 'node_modules/rollup/dist/bin/rollup', '-c', 'rollup.config.mjs'], cwd=stage, env=env, check=True)
    package = stage / 'package'
    package.mkdir()
    shutil.copytree(stage / 'dist', package / 'dist')
    shutil.copytree(stage / 'src', package / 'src')
    shutil.copyfile(original / 'LICENSE', package / 'LICENSE')
    metadata.update(private=True, chatPatchRevision=1)
    for key in ['scripts', 'devDependencies', 'publishConfig']:
        metadata.pop(key, None)
    (package / 'package.json').write_text(json.dumps(metadata, indent=2) + '\n')
    provenance = {'upstreamPackage': '@xmtp/browser-sdk@7.0.0', 'sourceManifestSha256': sha(PINS.read_bytes()), 'sourcePatchSha256': sha(PATCH.read_bytes()), 'buildLockSha256': sha((BUILD / 'package-lock.json').read_bytes()), 'buildFiles': {name: sha((BUILD / name).read_bytes()) for name in ['package.json', 'rollup.config.mjs', 'tsconfig.json']}, 'builderSha256': sha(Path(__file__).read_bytes()), 'nodeVersion': subprocess.check_output(['node', '--version'], text=True).strip(), 'bindingsSha256': sha(args.bindings.read_bytes()), 'files': {p.relative_to(package).as_posix(): sha(p.read_bytes()) for p in sorted(package.rglob('*')) if p.is_file()}}
    (package / 'PROVENANCE.json').write_text(json.dumps(provenance, indent=2) + '\n')
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as archive:
        for p in sorted(package.rglob('*')):
            if not p.is_file():
                continue
            info = archive.gettarinfo(str(p), 'package/' + p.relative_to(package).as_posix())
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            info.mode = 0o644
            with p.open('rb') as data:
                archive.addfile(info, data)
    print('Built', output, 'SHA-256', sha(output.read_bytes()), flush=True)
    shutil.rmtree(stage)

if __name__ == '__main__':
    main()
