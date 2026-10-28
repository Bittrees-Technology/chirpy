#!/usr/bin/env python3
"""Pinned atomic runtime replacement for the already-armed Chat notifier.

Never starts/stops services, changes hooks, reads provider credentials into a
child process, or sends a test alert. Preserve uncertain attempts for review.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import types
import uuid

# Reuse the independently tested filesystem/candidate primitives, not an
# installed or dynamically discovered helper. The operator stages both files.
COMMON_SHA = '0fe4009d8977ac56141b417b6b98f91545daea04d77a67b98872e40f2b008983'
COMMON_PATH = Path(__file__).with_name('upgrade-mail-node.py')


def load_common():
    fd = os.open(COMMON_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536:
            raise ValueError('Unexpected helper file')
        source = stream.read(65537)
    if hashlib.sha256(source).hexdigest() != COMMON_SHA:
        raise ValueError('Reviewed helper differs')
    scope = types.ModuleType('reviewed_node_primitives')
    scope.__file__ = str(COMMON_PATH)
    exec(compile(source, str(COMMON_PATH), 'exec'), scope.__dict__)
    return scope


C = load_common()
ROOT = Path('/opt/chat-mail-alerts')
CONFIG = Path('/etc/chat-mail-alerts')
STATE = Path('/var/lib/chat-mail-alerts')
UNIT_DIR = Path('/etc/systemd/system')
LOCK = Path('/run/chat-mail-alerts.install.lock')
ACCOUNT = 'chat-mail-alerts'
COMMIT = 'a19fd19e7c4933a71d4b6f32346f8e5886c299a6'
SCRIPT_SHA = 'fce3504a317a0d681212053a8c2e42fad7785090cbdebceb225eddedd91b87b7'
ALERT_UNITS = {
    'chat-mail-alert@.service': '821aec214957e38d7a2f8a153ad3f933e9fd53073a1ca95774229fccfa2d03b5',
    'chat-mail-alert-test.service': '93ff9911072deebd9a87f82589c72bb4bad4f0423edcc25d277ec3eed9b26ab0',
}
WORKERS = {
    'chat-mail-api-scheduler.service': '81c5aa132667a0e6911eb725ab83dc76710118b7c4ca90467ab9c134cdd060f8',
    'chat-mail-inbound.service': '8e662c6365cd499e962bda3f568d53f8a2c89c41be4cc76ed8d6b7e1780fe201',
    'chat-mail-inbound-health.service': '9d5a7959b097ac3cd56783a376d35a3f6247e3e1e53ac3d6f3eb36a3e70c137f',
}
HOOK = b'# Install only for reviewed Chat worker/health units after notifier acceptance.\n[Unit]\nOnFailure=chat-mail-alert@%n.service\n'
STEP = 'preflight'


def properties(name):
    raw = C.subprocess.check_output(['/usr/bin/systemctl', 'show', name, '-p', 'ActiveState',
        '-p', 'UnitFileState', '-p', 'FragmentPath', '-p', 'DropInPaths', '-p', 'NeedDaemonReload',
        '-p', 'OnFailure'], env=C.ENV, text=True, timeout=15)
    return dict(line.split('=', 1) for line in raw.splitlines())


def policy():
    result = {}
    for name, digest in {**ALERT_UNITS, **WORKERS}.items():
        path = UNIT_DIR / name
        C.parents(path)
        C.require(C.digest(path) == digest, 'Reviewed service file differs')
    for name in WORKERS:
        dropin = UNIT_DIR / (name + '.d') / '50-operator-alert.conf'
        C.parents(dropin)
        C.require(C.read(dropin) == HOOK, 'Reviewed failure hook differs')
        values = properties(name)
        expected = {'ActiveState': 'inactive', 'UnitFileState': 'static',
            'FragmentPath': str(UNIT_DIR / name), 'DropInPaths': str(dropin), 'NeedDaemonReload': 'no',
            'OnFailure': 'chat-mail-alert@' + name + '.service'}
        C.require(all(values.get(key) == value for key, value in expected.items()), 'Worker or alert policy changed')
        result[name] = values
        timer = name.replace('.service', '.timer')
        values = properties(timer)
        C.require(values.get('ActiveState') == 'inactive' and values.get('UnitFileState') == 'disabled', 'Delivery timer is enabled')
        result[timer] = values
    instances = ['chat-mail-alert@' + name + '.service' for name in [*WORKERS, 'chat-mail-alert-test.service']]
    loaded = C.subprocess.check_output(['/usr/bin/systemctl', 'list-units', 'chat-mail-alert@*.service',
        '--all', '--plain', '--no-legend', '--no-pager'], env=C.ENV, text=True, timeout=15)
    C.require(all(line.split()[0] in instances for line in loaded.splitlines() if line.strip()), 'Unknown alert instance needs review')
    for name in [*instances, 'chat-mail-alert-test.service']:
        values = properties(name)
        fragment = 'chat-mail-alert-test.service' if name == 'chat-mail-alert-test.service' else 'chat-mail-alert@.service'
        C.require(values.get('ActiveState') == 'inactive' and values.get('UnitFileState') == 'static' and
            values.get('FragmentPath') == str(UNIT_DIR / fragment) and not values.get('DropInPaths') and
            values.get('NeedDaemonReload') == 'no', 'Notifier is busy or changed')
        result[name] = values
    C.no_runtime_processes([{'root': ROOT}])
    return result


def software():
    expected = {ROOT, ROOT / 'runtime', ROOT / 'runtime/bin', ROOT / 'runtime/bin/node', ROOT / 'mail-operator-alert.mjs'}
    actual = {ROOT, *ROOT.rglob('*')}
    C.require(actual == expected, 'Notifier software file set differs')
    for path in actual:
        C.protected(path)
    C.require(C.digest(ROOT / 'mail-operator-alert.mjs') == SCRIPT_SHA, 'Reviewed notifier differs')


def configuration():
    result = C.snapshot(CONFIG)
    own = C.paths({'root': ROOT, 'config': CONFIG})
    # New durable markers/rollback belong to this operation. Preserve every
    # pre-existing configuration entry; validate our backup separately.
    result = {path: value for path, value in result.items() if
        Path(path) not in (own['attempt'], own['receipt'], own['backup']) and
        own['backup'] not in Path(path).parents}
    for path, (uid, gid, mode, digest) in result.items():
        C.require(stat.S_IMODE(mode) == (0o700 if stat.S_ISDIR(mode) else 0o600), 'Private configuration permissions differ')
    installed = json.loads(C.read(CONFIG / 'install-receipt.json'))
    C.require(installed.get('commit') == COMMIT and installed.get('installed') is True and
        installed.get('runtimeSha256') == C.OLD_SHA and installed.get('files', {}).get('mail-operator-alert.mjs') == SCRIPT_SHA,
        'Reviewed installation receipt differs')
    activation = json.loads(C.read(CONFIG / 'failure-hooks-receipt.json'))
    C.require(activation.get('operatorAlertsEnabled') is True and activation.get('failureHooksInstalled') == list(WORKERS), 'Alert activation receipt differs')
    before = C.read(CONFIG / 'alerts.env.before-hooks')
    configured = json.loads(C.read(CONFIG / 'provider-configuration-receipt.json'))
    C.require(hashlib.sha256(before).hexdigest() == configured.get('afterSha256') and
        configured.get('configured') is True and configured.get('syntheticTestProviderAccepted') is True and
        configured.get('recipients') == activation.get('recipients'), 'Provider configuration receipt differs')
    C.require(before.count(b'CHAT_MAIL_ALERTS_ENABLED=0\n') == 1 and C.read(CONFIG / 'alerts.env') ==
        before.replace(b'CHAT_MAIL_ALERTS_ENABLED=0\n', b'CHAT_MAIL_ALERTS_ENABLED=1\n'), 'Armed alert configuration differs')
    return result


def delivery_state(account):
    names = {name + suffix for name in [*WORKERS, 'chat-mail-alert-test.service'] for suffix in ('.json', '.lock')}
    C.require({path.name for path in STATE.iterdir()} <= names, 'Unknown notifier state entry')
    for path in [STATE, *STATE.iterdir()]:
        info = path.lstat()
        directory = path == STATE
        C.require(info.st_uid == account.pw_uid and info.st_gid == account.pw_gid and
            (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1) and
            stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600), 'Notifier state permissions differ')
        if not directory:
            C.require(info.st_size <= 8192, 'Notifier state exceeds bound')
    return C.snapshot(STATE, root_owned=False)


def unchanged(before, after):
    C.require(all(after.get(path) == value for path, value in before.items()), 'Configuration changed')


def verify_binary(path, digest, group):
    info = C.protected(path)
    C.require(stat.S_IMODE(info.st_mode) == 0o550 and info.st_gid == group and C.digest(path) == digest,
        'Runtime copy integrity differs')


def verify_backup(files, group):
    verify_binary(files['backup'] / 'node', C.OLD_SHA, group)
    C.require(C.digest(files['backup'] / 'new-runtime-LICENSE') == C.LICENSE_SHA, 'Rollback license differs')


def upgrade(candidate, license_path):
    global STEP
    STEP = 'preflight'
    C.require(os.geteuid() == 0 and sys.platform == 'linux', 'Use the administrator on the reviewed Linux host')
    C.parents(ROOT); C.parents(CONFIG); C.parents(STATE.parent)
    account = C.pwd.getpwnam(ACCOUNT)
    C.require(account.pw_uid != 0 and account.pw_gid != 0 and os.getgrouplist(ACCOUNT, account.pw_gid) == [account.pw_gid], 'Notifier account differs')
    files = C.paths({'root': ROOT, 'config': CONFIG})
    with C.install_lock(LOCK):
        C.require(all(not os.path.lexists(files[key]) for key in ('backup', 'attempt', 'receipt', 'candidate')), 'Prior attempt requires reconciliation; do not rerun')
        info = C.protected(files['node'])
        C.require(stat.S_IMODE(info.st_mode) == 0o550 and info.st_gid == account.pw_gid and C.digest(files['node']) == C.OLD_SHA, 'Original runtime differs')
        C.require(C.shutil.disk_usage(ROOT).free >= C.MIN_FREE + C.NEW_BYTES + info.st_size, 'Insufficient storage reserve')
        cinfo = candidate.lstat()
        C.require(stat.S_ISREG(cinfo.st_mode) and cinfo.st_nlink == 1 and cinfo.st_size == C.NEW_BYTES and C.digest(candidate) == C.NEW_SHA, 'Pinned candidate mismatch')
        license_bytes = C.read(license_path, 2 * 1024 ** 2)
        C.require(hashlib.sha256(license_bytes).hexdigest() == C.LICENSE_SHA, 'Pinned license mismatch')
        STEP = 'preflight-software'
        software()
        STEP = 'preflight-configuration'
        config = configuration()
        STEP = 'preflight-state'
        state = delivery_state(account)
        STEP = 'preflight-services'
        units = policy()
        operation = uuid.uuid4().hex
        STEP = 'preserve-original'
        C.create(files['attempt'], (json.dumps({'operation': operation, 'neverAutomaticallyRetry': True}) + '\n').encode())
        files['backup'].mkdir(mode=0o700); C.sync_dir(CONFIG)
        original = C.read(files['node'], 256 * 1024 ** 2)
        C.require(hashlib.sha256(original).hexdigest() == C.OLD_SHA, 'Original runtime changed')
        C.create(files['backup'] / 'node', original, stat.S_IMODE(info.st_mode), info.st_gid)
        del original
        C.create(files['backup'] / 'new-runtime-LICENSE', license_bytes)
        C.copy_candidate(candidate, files['candidate'], info)
        C.require(policy() == units and delivery_state(account) == state, 'Notifier activity requires reconciliation')
        unchanged(config, configuration()); software()
        C.require(C.digest(files['node']) == C.OLD_SHA, 'Original runtime changed')
        verify_backup(files, info.st_gid)
        verify_binary(files['candidate'], C.NEW_SHA, info.st_gid)
        STEP = 'replace-runtime'
        # Atomic replacement keeps the executable path available even if an
        # already-armed failure hook fires between the final check and rename.
        os.replace(files['candidate'], files['node']); C.sync_dir(files['node'].parent)
        STEP = 'disabled-runtime-check'
        verify_binary(files['node'], C.NEW_SHA, info.st_gid)
        prefix = ['/usr/sbin/runuser', '-u', ACCOUNT, '--', str(files['node'])]
        version = C.subprocess.run([*prefix, '--version'], env=C.ENV, capture_output=True, text=True, check=True, timeout=20)
        C.require(version.stdout.strip() == 'v' + C.VERSION, 'Unexpected Node version')
        probe = C.subprocess.run([*prefix, str(ROOT / 'mail-operator-alert.mjs'), '--failure', 'chat-mail-alert-test.service'],
            cwd=ROOT, env={**C.ENV, 'CHAT_MAIL_ALERTS_ENABLED': '0'}, capture_output=True, text=True, check=True, timeout=20)
        C.require(json.loads(probe.stdout) == {'enabled': False}, 'Disabled notifier contract failed')
        C.require(C.digest(files['node']) == C.NEW_SHA and policy() == units and delivery_state(account) == state, 'Notifier activity requires reconciliation')
        unchanged(config, configuration()); software()
        verify_backup(files, info.st_gid)
        STEP = 'receipt'
        result = {'upgraded': True, 'component': 'operator-alerts', 'nodeVersion': C.VERSION, 'nodeSha256': C.NEW_SHA,
            'baseCommit': COMMIT, 'operation': operation, 'rollbackPreserved': True, 'configurationPreserved': True,
            'deliveryStatePreserved': True, 'failureHooksPreserved': True, 'atomicExecutableReplacement': True,
            'disabledRuntimePassed': True, 'servicesRestarted': False, 'mailSent': False}
        C.create(files['receipt'], (json.dumps(result, indent=2) + '\n').encode())
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--license', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(upgrade(args.candidate, args.license)))


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'upgraded': False, 'stoppedAt': STEP, 'errorType': type(error).__name__,
            'doNotRerun': True, 'privateReviewRequired': True}))
        raise SystemExit(1)
