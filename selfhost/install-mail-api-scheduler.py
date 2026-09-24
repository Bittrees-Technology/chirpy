#!/usr/bin/env python3
"""First install of the stateless Resend API scheduler from a reviewed package.

No package code, credentials, worker or timer is executed or activated.
The expected SHA256 must come from the reviewed deployment record, not the bundle.
"""
import argparse
from contextlib import contextmanager
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile

ACCOUNT = 'chat-mail-api-scheduler'
TARGET = Path('/opt/chat-mail-api-scheduler')
CONFIG = Path('/etc/chat-mail-api-scheduler')
LOCK = Path('/run/chat-mail-api-scheduler.install.lock')
UNITS = Path('/etc/systemd/system')
UNIT_NAMES = ('chat-mail-api-scheduler.service', 'chat-mail-api-scheduler.timer')
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_ENTRIES = 32
COMMAND_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'}
PAYLOAD_FILES = {
    'runtime/bin/node', 'selfhost/mail-api-scheduler.mjs',
    'selfhost/mail-api-scheduler.env.example',
    'selfhost/systemd/chat-mail-api-scheduler.service',
    'selfhost/systemd/chat-mail-api-scheduler.timer',
}
REQUIRED = PAYLOAD_FILES | {'bundle.json'}
DIRECTORIES = {str(parent) for name in REQUIRED for parent in PurePosixPath(name).parents
               if str(parent) != '.'}
ENVIRONMENT = """# Prepare privately. Installing this file does not authorize sending or scheduling.
CHAT_MAIL_API_SCHEDULER_ENABLED=0
CHIRPY_MAIL_PROVIDER=resend
CHIRPY_MAIL_SERVICE_URL=https://chirpy.bittrees.org/api/mail
CHIRPY_MAIL_WORKER_SECRET=
"""


class InstallationError(ValueError):
    """A fixed diagnostic safe to show without archive data or secrets."""


def require(condition, message):
    if not condition:
        raise InstallationError(message)


def snapshot(source, target, expected):
    """Hash the private snapshot, never extract the mutable source pathname."""
    require(re.fullmatch(r'[a-f0-9]{64}', expected), 'Expected a reviewed SHA256')
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    descriptor = os.open(source, flags)
    with os.fdopen(descriptor, 'rb') as incoming, target.open('xb') as outgoing:
        info = os.fstat(incoming.fileno())
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_ARCHIVE,
                'Bundle must be a bounded regular file')
        digest, length = hashlib.sha256(), 0
        while chunk := incoming.read(1024 * 1024):
            length += len(chunk)
            require(length <= MAX_ARCHIVE, 'Bundle grew beyond the size limit')
            outgoing.write(chunk)
            digest.update(chunk)
    require(digest.hexdigest() == expected, 'Bundle SHA256 does not match review')


def extract(snapshot_file, destination):
    """Accept only canonical, unique directories/files, never tar links/devices."""
    seen, regular, total = set(), set(), 0
    with tarfile.open(snapshot_file, 'r:*') as bundle:
        for member in bundle:
            name = member.name
            path = PurePosixPath(name)
            require(name and str(path) == name and not path.is_absolute() and
                    '..' not in path.parts and '.' not in path.parts and
                    '\\' not in name and not any(ord(c) < 32 for c in name) and
                    len(name) < 1024, 'Noncanonical bundle path')
            require((member.isfile() and name in REQUIRED) or
                    (member.isdir() and name in DIRECTORIES), 'Unexpected bundle entry')
            require(name not in seen and len(seen) < MAX_ENTRIES,
                    'Duplicate or excessive bundle entries')
            require(member.isdir() or member.isfile(), 'Bundle links/devices are forbidden')
            require(0 <= member.size <= (MAX_EXPANDED if name == 'runtime/bin/node' else 1048576),
                    'Invalid bundle entry size')
            seen.add(name)
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if member.isdir():
                target.mkdir(exist_ok=True, mode=0o700)
                continue
            total += member.size
            require(total <= MAX_EXPANDED, 'Expanded bundle is too large')
            with bundle.extractfile(member) as incoming, target.open('xb') as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
            require(target.stat().st_size == member.size, 'Truncated bundle file')
            # Preserve executable intent only; discard archive ownership/setuid/modes.
            target.chmod(0o500 if member.mode & 0o111 else 0o400)
            regular.add(name)
    require(REQUIRED <= regular, 'Bundle is incomplete')
    require((destination / 'runtime/bin/node').stat().st_mode & 0o100,
            'Runtime must be executable')
    metadata = json.loads((destination / 'bundle.json').read_text())
    require(isinstance(metadata, dict) and metadata.get('version') == 1 and
            isinstance(metadata.get('commit'), str) and
            re.fullmatch(r'[a-f0-9]{40}', metadata['commit']) and
            isinstance(metadata.get('tree'), str) and
            re.fullmatch(r'[a-f0-9]{40}', metadata['tree']), 'Invalid release provenance')
    require(metadata.get('component') == ACCOUNT and
            isinstance(metadata.get('files'), dict) and
            set(metadata['files']) == PAYLOAD_FILES, 'Invalid scheduler manifest')
    for name, expected in metadata['files'].items():
        require(isinstance(expected, str) and re.fullmatch(r'[a-f0-9]{64}', expected),
                'Invalid file digest')
        with (destination / name).open('rb') as file:
            digest = hashlib.sha256()
            while chunk := file.read(1024 * 1024):
                digest.update(chunk)
            actual = digest.hexdigest()
        require(actual == expected, 'Package file digest mismatch')
    require((destination / 'selfhost/mail-api-scheduler.env.example').read_text() == ENVIRONMENT,
            'Scheduler must install with reviewed disabled configuration')
    return metadata


def protect_tree(directory, group_id):
    for path in [directory, *directory.rglob('*')]:
        require(not path.is_symlink(), 'Unexpected installed symlink')
        info = path.stat()
        os.chown(path, 0, group_id)
        path.chmod(0o750 if path.is_dir() else (0o550 if info.st_mode & 0o100 else 0o440))


def run(*args):
    # No user environment, PATH lookup, shell, npm scripts or package code as root.
    subprocess.run(args, check=True, env=COMMAND_ENV)


def preflight():
    require(os.geteuid() == 0, 'Administrator installation requires sudo')
    for parent in (TARGET.parent, CONFIG.parent, UNITS):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'Installation parents must be protected root-owned directories')
    # Refuse even dangling links or an older installation; this is never an upgrade/reset.
    for path in (TARGET, CONFIG, *(UNITS / name for name in UNIT_NAMES)):
        require(not os.path.lexists(path), 'Existing installation requires a reviewed migration')
    # Pre-existing drop-ins or dangling enablement links can affect a newly installed
    # unit even while its LoadState is not-found. Never silently inherit these.
    for directory in (UNITS, Path('/run/systemd/system'), Path('/usr/local/lib/systemd/system'),
                      Path('/usr/lib/systemd/system')):
        for name in (*UNIT_NAMES, *(name + '.d' for name in UNIT_NAMES),
                     'service.d', 'timer.d', 'chat-.service.d', 'chat-mail-.service.d',
                     'chat-.timer.d', 'chat-mail-.timer.d',
                     'chat-mail-api-.service.d', 'chat-mail-api-.timer.d'):
            require(not os.path.lexists(directory / name), 'Existing unit policy requires review')
        for name in UNIT_NAMES:
            require(not list(directory.glob('*.wants/' + name)) and
                    not list(directory.glob('*.requires/' + name)), 'Existing unit activation requires review')
    for lookup in (pwd.getpwnam, grp.getgrnam):
        try:
            lookup(ACCOUNT)
        except KeyError:
            continue
        raise InstallationError('Service account/group already exists')
    for unit in UNIT_NAMES:
        result = subprocess.run(['/usr/bin/systemctl', 'show', unit, '-p', 'LoadState', '--value'],
                                check=True, capture_output=True, text=True, env=COMMAND_ENV)
        require(result.stdout.strip() == 'not-found', 'Existing system unit requires review')


def install(payload, metadata, digest):
    # Validate syntax before creating accounts or target paths. Substitute only the
    # not-yet-installed binary for offline verification; install the original unit.
    unit_source = payload / 'selfhost/systemd'
    with tempfile.TemporaryDirectory(prefix='chat-unit-check-') as folder:
        check = Path(folder)
        for name in UNIT_NAMES:
            content = (unit_source / name).read_text()
            if name.endswith('.service'):
                content = content.replace('/opt/chat-mail-api-scheduler/runtime/bin/node', '/usr/bin/true')
            (check / name).write_text(content)
        run('/usr/bin/systemd-analyze', 'verify', '--man=no', '--generators=no',
            *(str(check / name) for name in UNIT_NAMES))
    run('/usr/sbin/useradd', '--system', '--user-group', '--home-dir', '/nonexistent',
        '--no-create-home', '--shell', '/usr/sbin/nologin', ACCOUNT)
    identity = pwd.getpwnam(ACCOUNT)
    protect_tree(payload, identity.pw_gid)
    # Rename the verified root-private snapshot atomically on the /opt filesystem.
    payload.rename(TARGET)
    CONFIG.mkdir(mode=0o700)
    environment = CONFIG / 'worker.env'
    with environment.open('x') as file:
        file.write(ENVIRONMENT)
    environment.chmod(0o600)
    for name in UNIT_NAMES:
        with (UNITS / name).open('x') as file:
            file.write((TARGET / 'selfhost/systemd' / name).read_text())
        (UNITS / name).chmod(0o644)
    receipt = {'version': 1, 'bundleSha256': digest, 'commit': metadata['commit'],
               'tree': metadata['tree'], 'component': ACCOUNT, 'enabled': False, 'files': metadata['files']}
    (CONFIG / 'install-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (CONFIG / 'install-receipt.json').chmod(0o600)
    run('/usr/bin/systemctl', 'daemon-reload')
    # Intentionally no enable/start/restart, generated key or journal initialization.
    print(json.dumps({'installed': True, 'commit': metadata['commit'], 'enabled': False}))


@contextmanager
def installation_lock():
    # Never unlink the lock: a second installer must not lock a replacement inode.
    require(os.geteuid() == 0, 'Administrator installation requires sudo')
    parent = LOCK.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and
            not parent.st_mode & 0o022, 'Installation lock parent must be protected')
    descriptor = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                'Installation lock must be a private root-owned file')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def prepare(args):
    if not args.verify_only:
        preflight()
    # Snapshot and install on the same filesystem; verification creates only temp files.
    with tempfile.TemporaryDirectory(prefix='.chat-api-install-',
                                     dir=None if args.verify_only else TARGET.parent) as folder:
        root = Path(folder)
        pinned = root / 'bundle.tar'
        snapshot(args.bundle, pinned, args.sha256)
        payload = root / 'payload'
        payload.mkdir(mode=0o700)
        metadata = extract(pinned, payload)
        if args.verify_only:
            print(json.dumps({'verified': True, 'commit': metadata['commit'],
                              'tree': metadata['tree'], 'installed': False}))
        else:
            install(payload, metadata, args.sha256)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    if args.verify_only:
        prepare(args)
    else:
        with installation_lock():
            prepare(args)


if __name__ == '__main__':
    try:
        main()
    except InstallationError as error:
        raise SystemExit(str(error) + '. Preserve any partial installation and review before retrying. '
                         'No worker or timer was started.')
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError):
        # Avoid printing paths/content from a malformed archive or configuration.
        raise SystemExit('Installation/verification stopped. Preserve any partial installation; '
                         'review before retrying. No worker or timer was started.')
