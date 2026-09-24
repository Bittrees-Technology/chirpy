"""Privileged acceptance on a disposable GitHub Linux runner ONLY.

Uses synthetic configuration and the disabled worker; no mail, journal or network
requests. Never run this on Acer or any host retaining application state.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer', SOURCE / 'selfhost/install-mail-outbound.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def command(*args):
    return subprocess.check_output(args, text=True, env=installer.COMMAND_ENV).strip()


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    check(os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true' and
          len(sys.argv) == 3, 'Only a disposable privileged GitHub runner is supported')
    installer.preflight()  # Refuse all existing installations before any cleanup can run.
    release, node = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    check(release.is_dir() and node.is_file(), 'Prepared runtime required')
    with tempfile.TemporaryDirectory(prefix='chat-admin-acceptance-') as folder:
        root = Path(folder)
        bundle = root / 'bundle.tar.gz'
        metadata = root / 'bundle.json'
        metadata.write_text(json.dumps({'version': 1, 'commit': 'a' * 40, 'tree': 'b' * 40}))
        with tarfile.open(bundle, 'w:gz') as archive:
            archive.add(metadata, arcname='bundle.json')
            archive.add(node, arcname='runtime/bin/node')
            for path in sorted(release.rglob('*')):
                # Runtime doesn't need npm executable links. Reject every other link.
                relative = path.relative_to(release)
                if '.bin' in relative.parts:
                    continue
                check(not path.is_symlink(), 'Unexpected runtime link')
                archive.add(path, arcname='release/' + str(relative), recursive=False)
        digest = hashlib.file_digest(bundle.open('rb'), 'sha256').hexdigest()
        try:
            command('/usr/bin/python3', '-I', str(SOURCE / 'selfhost/install-mail-outbound.py'),
                    str(bundle), '--sha256', digest)
            check(command('/usr/bin/systemctl', 'show', 'chat-mail-outbound.timer',
                          '-p', 'UnitFileState', '--value') == 'disabled', 'Timer must stay disabled')
            for name in installer.UNIT_NAMES:
                check(command('/usr/bin/systemctl', 'show', name, '-p', 'ActiveState', '--value') == 'inactive',
                      'Installation activated a unit')
            receipt = json.loads((installer.CONFIG / 'install-receipt.json').read_text())
            check(receipt['bundleSha256'] == digest and not receipt['journalProvisioned'], 'Receipt mismatch')
            for path in [installer.TARGET, *installer.TARGET.rglob('*')]:
                info = path.stat()
                check(info.st_uid == 0 and not info.st_mode & 0o022, 'Code/runtime must be root-owned and protected')
            check((installer.CONFIG / 'worker.env').stat().st_mode & 0o777 == 0o600, 'Config mode')
            check(installer.CONFIG.stat().st_mode & 0o777 == 0o700, 'Config directory mode')
            check(installer.STATE.stat().st_mode & 0o777 == 0o700, 'State mode')
            check(installer.STATE.stat().st_uid != 0, 'State must have the dedicated owner')
            # Real shipped command: disabled path imports the actual dependencies and
            # exits without configuration, journal initialization or external calls.
            command('/usr/bin/systemctl', 'start', 'chat-mail-outbound.service')
            check(command('/usr/bin/systemctl', 'show', 'chat-mail-outbound.service',
                          '-p', 'Result', '--value') == 'success', 'Disabled service failed')
            check(list(installer.STATE.iterdir()) == [], 'Disabled service must not create a journal')

            # Exercise the real unit's effective mount/identity restrictions with a
            # root-owned temporary probe. Only ExecStart changes in this CI fixture.
            hidden = Path('/home/chat-mail-ci-secret')
            check(not hidden.exists(), 'Unexpected fixture path')
            hidden.write_text('synthetic home fixture')
            hidden.chmod(0o644)  # World-readable outside ProtectHome, deliberately.
            probe = installer.TARGET / 'probe.mjs'
            probe.write_text('''import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
if(process.getuid()===0)throw Error('Root service');
function denied(action){let blocked=false;try{action();}catch(e){if(['EACCES','EPERM','EROFS'].includes(e.code))blocked=true;else throw e;}if(!blocked)throw Error('Isolation missing');}
denied(()=>readFileSync('/home/chat-mail-ci-secret'));
denied(()=>readFileSync('/etc/chat-mail-outbound/worker.env'));
denied(()=>writeFileSync('/opt/chat-mail-outbound/release/forbidden','x'));
denied(()=>writeFileSync('/etc/chat-mail-ci-forbidden','x'));
writeFileSync('/var/lib/chat-mail-outbound/probe','fixture',{mode:0o600});
unlinkSync('/var/lib/chat-mail-outbound/probe');
console.log('Dedicated user, protected home/config/code and writable state accepted');
''')
            probe.chmod(0o644)
            dropin = installer.UNITS / 'chat-mail-outbound.service.d'
            dropin.mkdir()
            (dropin / 'ci.conf').write_text('[Service]\nExecStart=\nExecStart=/opt/chat-mail-outbound/runtime/bin/node /opt/chat-mail-outbound/probe.mjs\n')
            command('/usr/bin/systemctl', 'daemon-reload')
            command('/usr/bin/systemctl', 'start', 'chat-mail-outbound.service')
            check(command('/usr/bin/systemctl', 'show', 'chat-mail-outbound.service',
                          '-p', 'Result', '--value') == 'success', 'Sandbox probe failed')
            check(command('/usr/bin/systemctl', 'show', 'chat-mail-outbound.timer',
                          '-p', 'ActiveState', '--value') == 'inactive', 'Timer activated during acceptance')
            hidden.unlink()
            print('Actual administrator install, disabled runtime and systemd sandbox accepted; no sending enabled.')
        finally:
            # Only the fresh fixture allowed by the first preflight; this script never
            # permits an existing installation and never runs outside disposable CI.
            subprocess.run(['/usr/bin/systemctl', 'stop', *installer.UNIT_NAMES], check=False)
            for name in installer.UNIT_NAMES:
                (installer.UNITS / name).unlink(missing_ok=True)
            shutil.rmtree(installer.UNITS / 'chat-mail-outbound.service.d', ignore_errors=True)
            command('/usr/bin/systemctl', 'daemon-reload')
            for path in (installer.TARGET, installer.CONFIG, installer.STATE):
                if path.exists():
                    shutil.rmtree(path)
            subprocess.run(['/usr/sbin/userdel', installer.ACCOUNT], check=False)


if __name__ == '__main__':
    main()
