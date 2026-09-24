#!/usr/bin/env python3
"""First installation only; a pinned package is copied before it is trusted.

No package code, install hook, worker, journal initializer or timer is executed.
The expected SHA256 must come from the reviewed deployment record, not the bundle.
"""
import argparse
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

ACCOUNT = 'chat-mail-outbound'
TARGET = Path('/opt/chat-mail-outbound')
CONFIG = Path('/etc/chat-mail-outbound')
STATE = Path('/var/lib/chat-mail-outbound')
UNITS = Path('/etc/systemd/system')
UNIT_NAMES = ('chat-mail-outbound.service', 'chat-mail-outbound.timer')
MAX_ARCHIVE = 1024 * 1024 * 1024
MAX_EXPANDED = 2 * MAX_ARCHIVE
MAX_ENTRIES = 100000
COMMAND_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'}
REQUIRED = {
    'bundle.json', 'runtime/bin/node', 'release/package.json',
    'release/package-lock.json', 'release/selfhost/mail-worker.package.json',
    'release/selfhost/mail-worker.package-lock.json',
    'release/selfhost/mail-outbound-worker.mjs',
    'release/selfhost/mail-smtp-transport.mjs', 'release/selfhost/mail-smtp-journal.mjs',
    'release/server/mail-service.js', 'release/server/mail-store.js',
    'release/node_modules/nodemailer/lib/smtp-connection/index.js',
    'release/node_modules/viem/package.json', 'release/node_modules/svix/package.json',
    'release/selfhost/systemd/chat-mail-outbound.service',
    'release/selfhost/systemd/chat-mail-outbound.timer',
}
ENVIRONMENT = '''# Installed disabled. Configure and accept delivery before activation.
NODE_ENV=production
CHIRPY_MAIL_ENABLED=0
CHAT_MAIL_OUTBOUND_WORKER_ENABLED=0
CHIRPY_MAIL_PROVIDER=smtp
CHIRPY_MAIL_SERVICE_URL=https://chirpy.bittrees.org/api/mail
CHIRPY_MAIL_FROM=
CHIRPY_MAIL_SENDERS=
CHIRPY_MAIL_DATA_KEY=
CHIRPY_MAIL_WORKER_SECRET=
KV_REST_API_URL=
KV_REST_API_TOKEN=
CHIRPY_MAIL_IDENTITY_URL=
CHIRPY_MAIL_IDENTITY_SECRET=
CHAT_SMTP_HOST=127.0.0.1
CHAT_SMTP_PORT=25
CHAT_SMTP_TLS_SERVERNAME=
CHAT_SMTP_TLS_CA_FILE=
CHAT_SMTP_USER=
CHAT_SMTP_PASSWORD=
CHAT_SMTP_JOURNAL_FILE=/var/lib/chat-mail-outbound/journal.sqlite
CHAT_SMTP_JOURNAL_KEY=
CHAT_SMTP_JOURNAL_ID=
CHAT_SMTP_PROFILE=
'''


def require(condition, message):
    if not condition:
        raise ValueError(message)


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
            require(path.parts[0] in ('release', 'runtime', 'bundle.json'),
                    'Unexpected bundle root')
            require(name not in seen and len(seen) < MAX_ENTRIES,
                    'Duplicate or excessive bundle entries')
            require(member.isdir() or member.isfile(), 'Bundle links/devices are forbidden')
            require(member.size >= 0, 'Invalid bundle size')
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
    for filename in ('package.json', 'package-lock.json'):
        require((destination / 'release' / filename).read_bytes() ==
                (destination / 'release/selfhost' / ('mail-worker.' + filename)).read_bytes(),
                'Runtime manifests differ from the reviewed source')
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
    for parent in (TARGET.parent, CONFIG.parent, STATE.parent, UNITS):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'Installation parents must be protected root-owned directories')
    # Refuse even dangling links or an older installation; this is never an upgrade/reset.
    for path in (TARGET, CONFIG, STATE, *(UNITS / name for name in UNIT_NAMES)):
        require(not os.path.lexists(path), 'Existing installation requires a reviewed migration')
    # Pre-existing drop-ins or dangling enablement links can affect a newly installed
    # unit even while its LoadState is not-found. Never silently inherit these.
    for directory in (UNITS, Path('/run/systemd/system'), Path('/usr/local/lib/systemd/system'),
                      Path('/usr/lib/systemd/system')):
        for name in (*UNIT_NAMES, *(name + '.d' for name in UNIT_NAMES),
                     'service.d', 'timer.d', 'chat-.service.d', 'chat-mail-.service.d',
                     'chat-.timer.d', 'chat-mail-.timer.d'):
            require(not os.path.lexists(directory / name), 'Existing unit policy requires review')
        for name in UNIT_NAMES:
            require(not list(directory.glob('*.wants/' + name)) and
                    not list(directory.glob('*.requires/' + name)), 'Existing unit activation requires review')
    for lookup in (pwd.getpwnam, grp.getgrnam):
        try:
            lookup(ACCOUNT)
        except KeyError:
            continue
        raise ValueError('Service account/group already exists')
    for unit in UNIT_NAMES:
        result = subprocess.run(['/usr/bin/systemctl', 'show', unit, '-p', 'LoadState', '--value'],
                                check=True, capture_output=True, text=True, env=COMMAND_ENV)
        require(result.stdout.strip() == 'not-found', 'Existing system unit requires review')


def install(payload, metadata, digest):
    # Validate syntax before creating accounts or target paths. Substitute only the
    # not-yet-installed binary for offline verification; install the original unit.
    unit_source = payload / 'release/selfhost/systemd'
    with tempfile.TemporaryDirectory(prefix='chat-unit-check-') as folder:
        check = Path(folder)
        for name in UNIT_NAMES:
            content = (unit_source / name).read_text()
            if name.endswith('.service'):
                content = content.replace('/opt/chat-mail-outbound/runtime/bin/node', '/usr/bin/true')
            (check / name).write_text(content)
        run('/usr/bin/systemd-analyze', 'verify', '--man=no', '--generators=no',
            *(str(check / name) for name in UNIT_NAMES))
    run('/usr/sbin/useradd', '--system', '--user-group', '--home-dir', str(STATE),
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
    STATE.mkdir(mode=0o700)
    os.chown(STATE, identity.pw_uid, identity.pw_gid)
    for name in UNIT_NAMES:
        with (UNITS / name).open('x') as file:
            file.write((TARGET / 'release/selfhost/systemd' / name).read_text())
        (UNITS / name).chmod(0o644)
    receipt = {'version': 1, 'bundleSha256': digest, 'commit': metadata['commit'],
               'tree': metadata['tree'], 'forwardingEnabled': False, 'journalProvisioned': False}
    (CONFIG / 'install-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (CONFIG / 'install-receipt.json').chmod(0o600)
    run('/usr/bin/systemctl', 'daemon-reload')
    # Intentionally no enable/start/restart, generated key or journal initialization.
    print(json.dumps({'installed': True, 'commit': metadata['commit'], 'enabled': False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    if not args.verify_only:
        preflight()
    # /opt for same-filesystem atomic installation; ordinary temporary storage for review.
    with tempfile.TemporaryDirectory(prefix='.chat-mail-install-',
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


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError):
        # Avoid printing paths/content from a malformed archive or configuration.
        raise SystemExit('Installation/verification stopped. Preserve any partial installation; '
                         'review before retrying. No worker or timer was started.')
