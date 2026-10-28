#!/usr/bin/env python3
"""Pinned cold Node security upgrade for Chat mail workers only.

Never starts a service, timer or messaging client. An uncertain/interrupted
attempt is held for operator reconciliation, never automatically replayed.
"""
import argparse
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import uuid

VERSION = '24.22.1'
OLD_SHA = '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c'
NEW_SHA = 'e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb'
NEW_BYTES = 126879696
LICENSE_SHA = '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace'
MIN_FREE = 1024 ** 3
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/nonexistent'}
STEP = 'preflight'
COMPONENTS = {
    'inbound': {
        'root': Path('/opt/chat-mail-inbound'), 'config': Path('/etc/chat-mail-inbound'),
        'state': Path('/var/lib/chat-mail-inbound'), 'account': 'chat-mail-inbound',
        'lock': Path('/run/chat-mail-inbound.install.lock'),
        'units': ('chat-mail-inbound.service', 'chat-mail-inbound.timer',
                  'chat-mail-inbound-health.service', 'chat-mail-inbound-health.timer', 'chat-mail-source.socket'),
        'script': 'release/selfhost/mail-inbound-worker.mjs',
        'flag': 'CHAT_MAIL_INBOUND_WORKER_ENABLED', 'disabled': {'enabled': False},
    },
    'api-scheduler': {
        'root': Path('/opt/chat-mail-api-scheduler'), 'config': Path('/etc/chat-mail-api-scheduler'),
        'state': None, 'account': 'chat-mail-api-scheduler',
        'lock': Path('/run/chat-mail-api-scheduler.install.lock'),
        'units': ('chat-mail-api-scheduler.service', 'chat-mail-api-scheduler.timer'),
        'script': 'selfhost/mail-api-scheduler.mjs',
        'flag': 'CHAT_MAIL_API_SCHEDULER_ENABLED', 'disabled': {'enabled': False, 'status': 'disabled'},
    },
}

def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path, limit=4 * 1024 ** 2):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit, 'Unexpected file')
        data = stream.read(limit + 1)
    require(len(data) <= limit, 'File exceeds bound')
    return data


def digest(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Unexpected file')
        result = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def protected(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), 'Unexpected filesystem entry')
    require(info.st_uid == 0 and not info.st_mode & 0o022 and (not path.is_file() or info.st_nlink == 1), 'Unsafe ownership or permissions')
    return info


def parents(path):
    for parent in reversed(path.parents):
        protected(parent)
    return protected(path)


def install_lock(path):
    # /run locks disappear on reboot. Check every ancestor before creating one;
    # preserve and validate existing inodes rather than replacing them.
    parents(path.parent)
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except FileExistsError:
        fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    lock = os.fdopen(fd, 'r+b')
    try:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, 'Unsafe installation lock')
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        lock.close()
        raise
    return lock


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def create(path, data, mode=0o600, gid=0):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        os.fchown(stream.fileno(), 0, gid)
        os.fchmod(stream.fileno(), mode)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    sync_dir(path.parent)


def replace_metadata(path, data):
    original = protected(path)
    candidate = path.with_name(path.name + '.node-' + VERSION + '.new')
    create(candidate, data, stat.S_IMODE(original.st_mode), original.st_gid)
    os.replace(candidate, path)
    sync_dir(path.parent)


def snapshot(path, root_owned=True):
    if path is None:
        return None
    result = {}
    for entry in [path, *sorted(path.rglob('*'))]:
        info = protected(entry) if root_owned else entry.lstat()
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'Unsafe state entry')
        result[str(entry)] = (info.st_uid, info.st_gid, info.st_mode, digest(entry) if entry.is_file() else None)
    return result


def configuration_snapshot(component):
    root = component['config']
    source = root / 'source.json' if component['state'] is not None else None
    account = pwd.getpwnam(component['account'])
    if source is not None:
        require(account.pw_uid != 0 and account.pw_gid != 0, 'Service account must be unprivileged')
        require(os.path.lexists(source), 'Inbound source settings are missing')
    result = {}
    for entry in [root, *sorted(root.rglob('*'))]:
        if entry == source:
            # install-mail-inbound.py intentionally gives only this read-only
            # settings file to the service account. Never chown or rewrite it.
            info = entry.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                    info.st_uid == account.pw_uid and info.st_gid == account.pw_gid and
                    stat.S_IMODE(info.st_mode) == 0o400, 'Unsafe inbound source settings')
        else:
            info = protected(entry)
        result[str(entry)] = (info.st_uid, info.st_gid, info.st_mode, digest(entry) if entry.is_file() else None)
    return result


def verify_tree(root, bundle):
    files = bundle.get('files')
    require(isinstance(files, dict) and 1 <= len(files) <= 20000, 'Invalid manifest')
    actual = set()
    for path in [root, *root.rglob('*')]:
        protected(path)
        if path.is_file() and path != root / 'bundle.json':
            name = str(path.relative_to(root))
            actual.add(name)
            require(name in files and digest(path) == files[name], 'Runtime integrity mismatch')
    require(actual == set(files), 'Runtime file set differs')


def units(component):
    result = {}
    for name in component['units']:
        raw = subprocess.check_output(['/usr/bin/systemctl', 'show', name, '-p', 'ActiveState', '-p', 'UnitFileState',
                                       '-p', 'FragmentPath', '-p', 'DropInPaths', '-p', 'NeedDaemonReload'], env=ENV, text=True, timeout=15)
        values = dict(line.split('=', 1) for line in raw.splitlines())
        require(values['ActiveState'] == 'inactive', 'Worker or source is active')
        require(values['UnitFileState'] == ('static' if name.endswith('.service') else 'disabled'), 'Timer or socket is enabled')
        require(values.get('NeedDaemonReload') == 'no', 'Unit policy needs reconciliation')
        result[name] = values
    return result


def runtime_executables():
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            executable = os.readlink(entry / 'exe')
        except (FileNotFoundError, ProcessLookupError):
            continue
        yield executable


def no_runtime_processes(selected):
    targets = {str(c['root'] / 'runtime/bin/node') for c in selected}
    for executable in runtime_executables():
        require(executable.removesuffix(' (deleted)') not in targets, 'A runtime process is still active')


def paths(component):
    config, root = component['config'], component['root']
    stem = 'node-runtime-' + VERSION
    return {
        'node': root / 'runtime/bin/node', 'bundle': root / 'bundle.json',
        'backup': config / (stem + '-backup'), 'attempt': config / (stem + '-attempt.json'),
        'receipt': config / (stem + '-receipt.json'),
        'candidate': root.parent / ('.' + root.name + '-' + stem + '.candidate'),
    }


def copy_candidate(source, target, info):
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(source_fd, 'rb') as incoming:
        original = os.fstat(incoming.fileno())
        require(stat.S_ISREG(original.st_mode) and original.st_nlink == 1 and original.st_size == NEW_BYTES, 'Invalid candidate size')
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as outgoing:
            result, count = hashlib.sha256(), 0
            for block in iter(lambda: incoming.read(1024 * 1024), b''):
                count += len(block)
                require(count <= NEW_BYTES, 'Candidate changed')
                result.update(block)
                outgoing.write(block)
            require(count == NEW_BYTES and result.hexdigest() == NEW_SHA, 'Candidate hash mismatch')
            os.fchown(outgoing.fileno(), 0, info.st_gid)
            os.fchmod(outgoing.fileno(), stat.S_IMODE(info.st_mode))
            outgoing.flush()
            os.fsync(outgoing.fileno())
        current = os.fstat(incoming.fileno())
        stable = lambda info: (info.st_dev, info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_uid, info.st_gid)
        require(stable(current) == stable(original), 'Candidate metadata changed')
    sync_dir(target.parent)


def disabled_smoke(component):
    root, account = component['root'], pwd.getpwnam(component['account'])
    prefix = ['/usr/sbin/runuser', '-u', account.pw_name, '--', str(root / 'runtime/bin/node')]
    result = subprocess.run([*prefix, '--version'], env=ENV, capture_output=True, check=True, text=True, timeout=20)
    require(result.stdout.strip() == 'v' + VERSION, 'Unexpected Node version')
    if component['state'] is not None:
        script = "import {Client} from '@xmtp/node-sdk'; import nodemailer from 'nodemailer'; if(typeof Client.build!=='function'||typeof nodemailer.createTransport!=='function')throw Error('Import contract');"
        subprocess.run([*prefix, '--input-type=module', '-e', script], cwd=root / 'release', env=ENV, capture_output=True, check=True, timeout=30)
    result = subprocess.run([*prefix, str(root / component['script']), '--once'], cwd=root,
                            env={**ENV, component['flag']: '0'}, capture_output=True, check=True, timeout=20)
    require(json.loads(result.stdout) == component['disabled'], 'Disabled command contract failed')


def upgrade(selected, candidate, license_path, expected, expected_manifests):
    global STEP
    STEP = 'preflight'
    require(os.geteuid() == 0, 'Administrator execution required')
    require(sys.platform == 'linux', 'Use the reviewed Linux host')
    candidate_info = candidate.lstat()
    require(stat.S_ISREG(candidate_info.st_mode) and candidate_info.st_nlink == 1 and candidate_info.st_size == NEW_BYTES and digest(candidate) == NEW_SHA, 'Pinned candidate mismatch')
    license_bytes = read(license_path, 2 * 1024 ** 2)
    require(hashlib.sha256(license_bytes).hexdigest() == LICENSE_SHA, 'Pinned license mismatch')
    prepared, operation = [], uuid.uuid4().hex
    with ExitStack() as stack:
        for name in selected:
            component = COMPONENTS[name]
            root, config = component['root'], component['config']
            parents(root); parents(config)
            stack.enter_context(install_lock(component['lock']))
            files = paths(component)
            require(all(not os.path.lexists(files[key]) for key in ('backup', 'attempt', 'receipt', 'candidate')), 'Prior attempt requires reconciliation; do not rerun')
            require(shutil.disk_usage(root).free >= MIN_FREE + len(selected) * NEW_BYTES, 'Insufficient storage reserve')
            policy = units(component)
            raw = read(files['bundle'])
            require(hashlib.sha256(raw).hexdigest() == expected_manifests[name], 'Reviewed manifest differs')
            bundle = json.loads(raw)
            require(bundle.get('commit') == expected[name] and re.fullmatch(r'[a-f0-9]{40}', expected[name]), 'Reviewed base commit differs')
            require(not bundle.get('runtimeOverlays'), 'Unexpected runtime overlay')
            verify_tree(root, bundle)
            require(bundle['files'].get('runtime/bin/node') == OLD_SHA, 'Unexpected original runtime')
            node_info = protected(files['node'])
            account = pwd.getpwnam(component['account'])
            require(account.pw_uid != 0 and account.pw_gid != 0, 'Service account must be unprivileged')
            require(stat.S_IMODE(node_info.st_mode) == 0o550 and node_info.st_gid == account.pw_gid, 'Runtime permissions differ')
            env = read(config / 'worker.env')
            matches = re.findall(rb'^\s*(?:export\s+)?' + component['flag'].encode() + rb'\s*=(.*)$', env, re.M)
            require([value.strip() for value in matches] == [b'0'], 'Stored worker is not disabled')
            if component['state'] is not None:
                require(not os.path.lexists(component['state'] / 'sender/.operation-lock'), 'Sender operation is active')
                package = json.loads(read(root / 'release/node_modules/nodemailer/package.json'))
                require(package.get('name') == 'nodemailer' and package.get('version') == '10.1.4', 'Apply the reviewed mail dependency patch first')
            prepared.append((name, component, files, raw, bundle, node_info, policy, configuration_snapshot(component), snapshot(component['state'], root_owned=False)))
        no_runtime_processes([p[1] for p in prepared])
        STEP = 'preserve-original'
        for name, component, files, raw, bundle, info, policy, config_before, state_before in prepared:
            create(files['attempt'], (json.dumps({'operation': operation, 'version': VERSION, 'neverAutomaticallyRetry': True}) + '\n').encode())
            files['backup'].mkdir(mode=0o700)
            sync_dir(files['backup'].parent)
            create(files['backup'] / 'bundle.json', raw)
            create(files['backup'] / 'LICENSE', license_bytes)
            copy_candidate(candidate, files['candidate'], info)
        for name, component, files, raw, bundle, info, policy, config_before, state_before in prepared:
            require(units(component) == policy and snapshot(component['state'], root_owned=False) == state_before, 'State or service policy changed')
            current = configuration_snapshot(component)
            require(all(current.get(path) == value for path, value in config_before.items()), 'Configuration changed')
            require(read(files['bundle']) == raw and digest(files['node']) == OLD_SHA, 'Runtime changed during preparation')
        no_runtime_processes([p[1] for p in prepared])
        STEP = 'replace-runtime'
        updated = []
        for name, component, files, raw, bundle, info, policy, config_before, state_before in prepared:
            os.rename(files['node'], files['backup'] / 'node')
            sync_dir(files['node'].parent); sync_dir(files['backup'])
            os.rename(files['candidate'], files['node']); sync_dir(files['node'].parent)
            next_bundle = json.loads(raw)
            next_bundle['files']['runtime/bin/node'] = NEW_SHA
            next_bundle['runtimeOverlays'] = [{'version': VERSION, 'oldSha256': OLD_SHA, 'sha256': NEW_SHA, 'operation': operation}]
            replace_metadata(files['bundle'], (json.dumps(next_bundle, indent=2) + '\n').encode())
            verify_tree(component['root'], next_bundle)
            updated.append((name, component, files, next_bundle, policy, config_before, state_before))
        STEP = 'disabled-runtime-check'
        for name, component, files, bundle, policy, config_before, state_before in updated:
            disabled_smoke(component)
            require(units(component) == policy and snapshot(component['state'], root_owned=False) == state_before, 'State or service policy changed')
            current = configuration_snapshot(component)
            require(all(current.get(path) == value for path, value in config_before.items()), 'Configuration changed')
        no_runtime_processes([p[1] for p in updated])
        STEP = 'receipt'
        results = []
        for name, component, files, bundle, policy, config_before, state_before in updated:
            result = {'component': name, 'nodeVersion': VERSION, 'nodeSha256': NEW_SHA, 'baseCommit': bundle['commit'],
                      'operation': operation, 'filesVerified': len(bundle['files']), 'rollbackPreserved': True,
                      'configurationPreserved': True, 'statePreserved': True, 'disabledRuntimePassed': True,
                      'servicesRestarted': False, 'timersEnabled': False, 'messagingClientCreated': False, 'mailSent': False}
            create(files['receipt'], (json.dumps(result, indent=2) + '\n').encode())
            results.append(result)
        return {'upgraded': True, 'components': results, 'mailSent': False, 'forwardingEnabled': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', choices=('inbound', 'api-scheduler', 'both'), default='both')
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--license', type=Path, required=True)
    parser.add_argument('--expect-inbound-commit')
    parser.add_argument('--expect-scheduler-commit')
    parser.add_argument('--expect-inbound-manifest')
    parser.add_argument('--expect-scheduler-manifest')
    args = parser.parse_args()
    selected = ('inbound', 'api-scheduler') if args.component == 'both' else (args.component,)
    expected = {'inbound': args.expect_inbound_commit, 'api-scheduler': args.expect_scheduler_commit}
    require(all(isinstance(expected[name], str) and re.fullmatch(r'[a-f0-9]{40}', expected[name]) for name in selected), 'Reviewed base commits are required')
    manifests = {'inbound': args.expect_inbound_manifest, 'api-scheduler': args.expect_scheduler_manifest}
    require(all(isinstance(manifests[name], str) and re.fullmatch(r'[a-f0-9]{64}', manifests[name]) for name in selected), 'Reviewed manifest hashes are required')
    print(json.dumps(upgrade(selected, args.candidate, args.license, expected, manifests)))


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except BaseException as error:
        print(json.dumps({'upgraded': False, 'stoppedAt': STEP, 'errorType': type(error).__name__, 'doNotRerun': True}))
        sys.exit(1)
