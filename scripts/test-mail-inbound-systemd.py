"""Exercise the shipped disabled scheduler/unit on a disposable GitHub runner only."""
import grp
import hashlib
import importlib.util
import json
import stat
import tarfile
import tempfile
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parents[1]
NAME = 'chat-mail-inbound'
CODE = Path('/opt') / NAME
CONFIG = Path('/etc') / NAME
UNITS = Path('/etc/systemd/system')
NAMES = (NAME + '.service', NAME + '.timer', NAME + '-health.service', NAME + '-health.timer')
STATE = Path('/var/lib') / NAME
DROPIN = UNITS / (NAME + '.service.d')
HOME_FIXTURE = Path('/home/chat-mail-inbound-ci-secret')
WRITE_FIXTURE = Path('/opt/chat-mail-inbound-ci-writable')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'}
spec = importlib.util.spec_from_file_location('installer', SOURCE / 'selfhost/install-mail-inbound.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def check(value, message):
    if not value:
        raise RuntimeError(message)


def run(*args):
    return subprocess.check_output(args, text=True, env=ENV, timeout=45).strip()


def acceptance(node, release):
    installer.preflight()
    for lookup in (pwd.getpwnam, grp.getgrnam):
        try:
            lookup(NAME)
        except KeyError:
            pass
        else:
            raise RuntimeError('Refuse existing scheduler account/group')
    for path in (CODE, CONFIG, STATE, DROPIN, HOME_FIXTURE, WRITE_FIXTURE, installer.LOCK, *(UNITS / name for name in NAMES)):
        check(not os.path.lexists(path), 'Refuse existing scheduler or fixture')
    try:
        with tempfile.TemporaryDirectory(prefix='chat-api-install-ci-') as folder:
            root = Path(folder)
            bundle = root / 'bundle.tar'
            files = {}
            for path in sorted(release.rglob('*')):
                relative = path.relative_to(release)
                if '.bin' in relative.parts:
                    continue
                check(not path.is_symlink(), 'Unexpected runtime link')
                if path.is_file():
                    files['release/' + str(relative)] = path
            # Only disabled source checks are exercised; no Mail authority is fabricated.
            for name in sorted(installer.REQUIRED):
                if name.startswith('source/'):
                    fixture = root / Path(name).name
                    fixture.write_text("raise RuntimeError('Disabled fixture must never execute')\n")
                    files[name] = fixture
            files['runtime/bin/node'] = node
            hashes = {}
            for name, path in files.items():
                with path.open('rb') as file:
                    hashes[name] = hashlib.file_digest(file, 'sha256').hexdigest()
            metadata = root / 'bundle.json'
            metadata.write_text(json.dumps({'version': 1, 'component': NAME,
                                           'commit': 'a' * 40, 'tree': 'b' * 40, 'sourceCommit': 'd' * 40, 'files': hashes}))
            with tarfile.open(bundle, 'w') as archive:
                archive.add(metadata, arcname='bundle.json')
                for name, path in files.items():
                    archive.add(path, arcname=name)
            with bundle.open('rb') as file:
                digest = hashlib.file_digest(file, 'sha256').hexdigest()
            command = ('/usr/bin/python3', '-I', str(SOURCE / 'selfhost/install-mail-inbound.py'),
                       str(bundle), '--sha256', digest)
            run(*command)
            receipt = json.loads((CONFIG / 'install-receipt.json').read_text())
            check(receipt['bundleSha256'] == digest and receipt['files'] == hashes and
                  receipt['forwardingEnabled'] is False and receipt['senderProvisioned'] is False, 'Installation receipt mismatch')
            for path in [CODE, *CODE.rglob('*')]:
                info = path.stat()
                check(info.st_uid == 0 and not info.st_mode & 0o022, 'Unprotected code/runtime')
            check(CONFIG.stat().st_mode & 0o777 == 0o750 and
                  (CONFIG / 'worker.env').stat().st_mode & 0o777 == 0o600, 'Unprotected configuration')
            check(run('/usr/bin/systemctl', 'show', NAMES[1], '-p', 'UnitFileState', '--value') == 'disabled', 'Schedule enabled')
            for name in NAMES:
                check(run('/usr/bin/systemctl', 'show', name, '-p', 'ActiveState', '--value') == 'inactive', 'Installation started a unit')
            repeated = subprocess.run(command, capture_output=True, text=True, env=ENV, timeout=45)
            check(repeated.returncode != 0 and
                  json.loads((CONFIG / 'install-receipt.json').read_text()) == receipt,
                  'Repeated installation must refuse existing state')
        run('/usr/bin/systemctl', 'start', NAMES[0])
        check(run('/usr/bin/systemctl', 'show', NAMES[0], '-p', 'Result', '--value') == 'success', 'Disabled scheduler failed')
        check(list(STATE.iterdir()) == [], 'Disabled worker created sender/source state')
        # Check real kernel restrictions, not merely text in a unit template.
        HOME_FIXTURE.write_text('synthetic private-home fixture')
        HOME_FIXTURE.chmod(0o644)
        WRITE_FIXTURE.write_text('original')
        WRITE_FIXTURE.chmod(0o666)
        (CODE / 'probe.mjs').write_text('''import {readFileSync,writeFileSync} from 'node:fs';
if(process.getuid()===0)throw Error('Root process');
if(!/^NoNewPrivs:\\s+1$/m.test(readFileSync('/proc/self/status','utf8')))throw Error('Privilege restriction missing');
function denied(fn){let rejected=false;try{fn();}catch(e){if(['EACCES','EPERM','EROFS'].includes(e.code))rejected=true;else throw e;}if(!rejected)throw Error('Isolation missing');}
denied(()=>readFileSync('/home/chat-mail-inbound-ci-secret'));
denied(()=>readFileSync('/etc/chat-mail-inbound/worker.env'));
denied(()=>writeFileSync('/opt/chat-mail-inbound-ci-writable','changed'));
denied(()=>writeFileSync('/opt/chat-mail-inbound/forbidden','x'));
if(JSON.parse(readFileSync('/etc/chat-mail-inbound/source.json','utf8')).enabled!==false)throw Error('Source enabled');
writeFileSync('/var/lib/chat-mail-inbound/synthetic-probe','fixture');
console.log('inbound worker dedicated user and kernel restrictions passed');
''')
        (CODE / 'probe.mjs').chmod(0o644)
        DROPIN.mkdir()
        (DROPIN / 'ci.conf').write_text('[Service]\nExecStart=\nExecStart=/opt/chat-mail-inbound/runtime/bin/node /opt/chat-mail-inbound/probe.mjs\n')
        run('/usr/bin/systemctl', 'daemon-reload')
        run('/usr/bin/systemctl', 'start', NAMES[0])
        check(run('/usr/bin/systemctl', 'show', NAMES[0], '-p', 'Result', '--value') == 'success', 'Sandbox probe failed')
        check(WRITE_FIXTURE.read_text() == 'original', 'System write permitted')
        check(run('/usr/bin/systemctl', 'show', NAMES[1], '-p', 'ActiveState', '--value') == 'inactive', 'Schedule started')
        print('Pinned inbound worker installation, repeat refusal, disabled service and real systemd isolation passed; no live requests.')
    finally:
        # Preflight above refuses existing paths/accounts before cleanup is reachable.
        subprocess.run(['/usr/bin/systemctl', 'stop', *NAMES], check=False, timeout=30)
        for name in NAMES:
            (UNITS / name).unlink(missing_ok=True)
        for path in (DROPIN, CONFIG, CODE, STATE):
            if path.exists():
                shutil.rmtree(path)
        for path in (HOME_FIXTURE, WRITE_FIXTURE):
            path.unlink(missing_ok=True)
        run('/usr/bin/systemctl', 'daemon-reload')
        installer.LOCK.unlink(missing_ok=True)
        try:
            pwd.getpwnam(NAME)
        except KeyError:
            pass
        else:
            run('/usr/sbin/userdel', NAME)


def main():
    check(os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true' and len(sys.argv) == 3,
          'Only a disposable privileged GitHub runner is supported')
    node = Path(sys.argv[2]).resolve()
    release = Path(sys.argv[1]).resolve()
    check(release.is_dir(), 'Prepared private runtime required')
    check(node.is_file(), 'Verified CI Node runtime required')
    # Hosted /opt permits tool installation. Harden only this disposable parent,
    # restoring it even if the production installer correctly refuses a fixture.
    parent = CODE.parent
    info = parent.lstat()
    check(stat.S_ISDIR(info.st_mode), 'Expected real fixture parent')
    try:
        os.chown(parent, 0, info.st_gid)
        parent.chmod(stat.S_IMODE(info.st_mode) & ~0o022)
        acceptance(node, release)
    finally:
        os.chown(parent, info.st_uid, info.st_gid)
        parent.chmod(stat.S_IMODE(info.st_mode))


if __name__ == '__main__':
    main()
