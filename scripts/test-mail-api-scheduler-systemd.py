"""Exercise the shipped disabled scheduler/unit on a disposable GitHub runner only."""
import grp
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parents[1]
NAME = 'chat-mail-api-scheduler'
CODE = Path('/opt') / NAME
CONFIG = Path('/etc') / NAME
UNITS = Path('/etc/systemd/system')
NAMES = (NAME + '.service', NAME + '.timer')
DROPIN = UNITS / (NAME + '.service.d')
HOME_FIXTURE = Path('/home/chat-mail-api-ci-secret')
WRITE_FIXTURE = Path('/opt/chat-mail-api-ci-writable')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'}


def check(value, message):
    if not value:
        raise RuntimeError(message)


def run(*args):
    return subprocess.check_output(args, text=True, env=ENV, timeout=45).strip()


def main():
    check(os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true' and len(sys.argv) == 2,
          'Only a disposable privileged GitHub runner is supported')
    node = Path(sys.argv[1]).resolve()
    check(node.is_file(), 'Verified CI Node runtime required')
    for lookup in (pwd.getpwnam, grp.getgrnam):
        try:
            lookup(NAME)
        except KeyError:
            pass
        else:
            raise RuntimeError('Refuse existing scheduler account/group')
    for path in (CODE, CONFIG, DROPIN, HOME_FIXTURE, WRITE_FIXTURE, *(UNITS / name for name in NAMES)):
        check(not os.path.lexists(path), 'Refuse existing scheduler or fixture')
    created_account = False
    try:
        run('/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--shell', '/usr/sbin/nologin', NAME)
        created_account = True
        (CODE / 'runtime/bin').mkdir(parents=True, mode=0o755)
        (CODE / 'selfhost').mkdir(mode=0o755)
        for directory in (CODE, CODE / 'runtime', CODE / 'runtime/bin', CODE / 'selfhost'):
            directory.chmod(0o755)
        shutil.copyfile(node, CODE / 'runtime/bin/node')
        (CODE / 'runtime/bin/node').chmod(0o755)
        shutil.copyfile(SOURCE / 'selfhost/mail-api-scheduler.mjs', CODE / 'selfhost/mail-api-scheduler.mjs')
        (CODE / 'selfhost/mail-api-scheduler.mjs').chmod(0o644)
        CONFIG.mkdir(mode=0o700)
        shutil.copyfile(SOURCE / 'selfhost/mail-api-scheduler.env.example', CONFIG / 'worker.env')
        (CONFIG / 'worker.env').chmod(0o600)
        for name in NAMES:
            shutil.copyfile(SOURCE / 'selfhost/systemd' / name, UNITS / name)
            (UNITS / name).chmod(0o644)
        run('/usr/bin/systemd-analyze', 'verify', *(str(UNITS / name) for name in NAMES))
        run('/usr/bin/systemctl', 'daemon-reload')
        check(run('/usr/bin/systemctl', 'show', NAMES[1], '-p', 'UnitFileState', '--value') == 'disabled', 'Schedule enabled')
        run('/usr/bin/systemctl', 'start', NAMES[0])
        check(run('/usr/bin/systemctl', 'show', NAMES[0], '-p', 'Result', '--value') == 'success', 'Disabled scheduler failed')
        # Check real kernel restrictions, not merely text in a unit template.
        HOME_FIXTURE.write_text('synthetic private-home fixture')
        HOME_FIXTURE.chmod(0o644)
        WRITE_FIXTURE.write_text('original')
        WRITE_FIXTURE.chmod(0o666)
        (CODE / 'probe.mjs').write_text('''import {readFileSync,writeFileSync} from 'node:fs';
if(process.getuid()===0)throw Error('Root process');
if(!/^NoNewPrivs:\\s+1$/m.test(readFileSync('/proc/self/status','utf8')))throw Error('Privilege restriction missing');
function denied(fn){let rejected=false;try{fn();}catch(e){if(['EACCES','EPERM','EROFS'].includes(e.code))rejected=true;else throw e;}if(!rejected)throw Error('Isolation missing');}
denied(()=>readFileSync('/home/chat-mail-api-ci-secret'));
denied(()=>readFileSync('/etc/chat-mail-api-scheduler/worker.env'));
denied(()=>writeFileSync('/opt/chat-mail-api-ci-writable','changed'));
denied(()=>writeFileSync('/opt/chat-mail-api-scheduler/forbidden','x'));
console.log('API scheduler dedicated user and kernel restrictions passed');
''')
        (CODE / 'probe.mjs').chmod(0o644)
        DROPIN.mkdir()
        (DROPIN / 'ci.conf').write_text('[Service]\nExecStart=\nExecStart=/opt/chat-mail-api-scheduler/runtime/bin/node /opt/chat-mail-api-scheduler/probe.mjs\n')
        run('/usr/bin/systemctl', 'daemon-reload')
        run('/usr/bin/systemctl', 'start', NAMES[0])
        check(run('/usr/bin/systemctl', 'show', NAMES[0], '-p', 'Result', '--value') == 'success', 'Sandbox probe failed')
        check(WRITE_FIXTURE.read_text() == 'original', 'System write permitted')
        check(run('/usr/bin/systemctl', 'show', NAMES[1], '-p', 'ActiveState', '--value') == 'inactive', 'Schedule started')
        print('Disabled API scheduler, template syntax and real systemd isolation passed; no live requests.')
    finally:
        # Preflight above refuses existing paths/accounts before cleanup is reachable.
        subprocess.run(['/usr/bin/systemctl', 'stop', *NAMES], check=False, timeout=30)
        for name in NAMES:
            (UNITS / name).unlink(missing_ok=True)
        for path in (DROPIN, CONFIG, CODE):
            if path.exists():
                shutil.rmtree(path)
        for path in (HOME_FIXTURE, WRITE_FIXTURE):
            path.unlink(missing_ok=True)
        run('/usr/bin/systemctl', 'daemon-reload')
        if created_account:
            run('/usr/sbin/userdel', NAME)


if __name__ == '__main__':
    main()
