#!/usr/bin/env python3
"""Real root filesystem fixtures; systemd/process discovery/runtime are mocked."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest


def sha(data):
    return hashlib.sha256(data).hexdigest()


class AlertUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(), 0)
        self.assertEqual(sys.platform, 'linux')
        self.assertTrue(os.environ.get('GITHUB_ACTIONS') == 'true' or Path('/.dockerenv').exists())
        spec = importlib.util.spec_from_file_location('alert_upgrade', Path(__file__).resolve().parents[1] / 'selfhost/upgrade-alert-node.py')
        self.m = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.m)
        m, c = self.m, self.m.C
        self.tmp = tempfile.TemporaryDirectory(prefix='chat-alert-node-test-', dir='/root')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        m.ROOT = self.base / 'opt/alerts'; m.CONFIG = self.base / 'etc/alerts'
        m.STATE = self.base / 'var/state'; m.UNIT_DIR = self.base / 'units'; m.LOCK = self.base / 'run/install.lock'
        for path in (m.ROOT / 'runtime/bin', m.CONFIG, m.STATE, m.UNIT_DIR, m.LOCK.parent):
            path.mkdir(parents=True, exist_ok=True); path.chmod(0o700)
        os.chown(m.STATE, 10001, 20001)
        self.old = b'original-node-fixture'; self.new = b'new-node-fixture-24.22.1'; self.license_bytes = b'synthetic license'
        c.OLD_SHA = sha(self.old); c.NEW_SHA = sha(self.new); c.NEW_BYTES = len(self.new); c.LICENSE_SHA = sha(self.license_bytes)
        self.node = m.ROOT / 'runtime/bin/node'; self.write(self.node, self.old, 0o550); os.chown(self.node, 0, 20001)
        script = b'fixture notifier'; self.write(m.ROOT / 'mail-operator-alert.mjs', script, 0o440); m.SCRIPT_SHA = sha(script)
        m.ALERT_UNITS = {name: sha(name.encode()) for name in m.ALERT_UNITS}
        m.WORKERS = {name: sha(name.encode()) for name in m.WORKERS}
        for name in [*m.ALERT_UNITS, *m.WORKERS]:
            self.write(m.UNIT_DIR / name, name.encode(), 0o644)
        for name in m.WORKERS:
            self.write(m.UNIT_DIR / (name + '.d') / '50-operator-alert.conf', m.HOOK, 0o644)
        previous = b'CHAT_MAIL_ALERTS_ENABLED=0\nRESEND_API_KEY=synthetic-not-a-provider-key\n'
        self.write(m.CONFIG / 'alerts.env.before-hooks', previous)
        self.write(m.CONFIG / 'alerts.env', previous.replace(b'ENABLED=0', b'ENABLED=1'))
        self.write(m.CONFIG / 'provider-configuration-receipt.json', json.dumps({'afterSha256': sha(previous), 'configured': True, 'syntheticTestProviderAccepted': True, 'recipients': ['fixture@invalid.test']}).encode())
        self.write(m.CONFIG / 'failure-hooks-receipt.json', json.dumps({'operatorAlertsEnabled': True, 'failureHooksInstalled': list(m.WORKERS), 'recipients': ['fixture@invalid.test']}).encode())
        self.write(m.CONFIG / 'install-receipt.json', json.dumps({'commit': m.COMMIT, 'installed': True, 'runtimeSha256': c.OLD_SHA, 'files': {'mail-operator-alert.mjs': m.SCRIPT_SHA}}).encode())
        self.delivery = m.STATE / 'chat-mail-alert-test.service.json'
        self.write(self.delivery, b'{"id":"synthetic-original","accepted":[true]}'); os.chown(self.delivery, 10001, 20001)
        self.candidate = self.base / 'candidate'; self.write(self.candidate, self.new)
        self.license = self.base / 'LICENSE'; self.write(self.license, self.license_bytes)
        self.calls = []; self.busy = None; self.unknown = False; self.fail_probe = False
        self.fail_version = False; self.runtime_active = False; self.before_replace = None
        def command(args, **kwargs):
            self.calls.append(args)
            self.assertEqual(args[0], '/usr/bin/systemctl')
            self.assertIn(args[1], ('show', 'list-units'))
            if args[1] == 'list-units':
                return 'chat-mail-alert@unexpected.service loaded inactive dead\n' if self.unknown else ''
            name = args[2]
            service = name.endswith('.service'); worker = name in m.WORKERS
            notifier = name.startswith('chat-mail-alert@')
            fragment = 'chat-mail-alert@.service' if notifier else name
            drop = str(m.UNIT_DIR / (name + '.d') / '50-operator-alert.conf') if worker else ''
            values = {'ActiveState': 'active' if self.busy == name else 'inactive', 'UnitFileState': 'static' if service else 'disabled',
                'FragmentPath': str(m.UNIT_DIR / fragment), 'DropInPaths': drop, 'NeedDaemonReload': 'no',
                'OnFailure': 'chat-mail-alert@' + name + '.service' if worker else ''}
            return '\n'.join(k + '=' + v for k, v in values.items()) + '\n'
        def run(args, **kwargs):
            self.calls.append(args)
            self.assertEqual(args[:4], ['/usr/sbin/runuser', '-u', m.ACCOUNT, '--'])
            self.assertNotIn('RESEND_API_KEY', kwargs['env'])
            if args[-1] == '--version':
                return types.SimpleNamespace(stdout='v0\n' if self.fail_version else 'v' + c.VERSION + '\n')
            self.assertEqual(args[-2:], ['--failure', 'chat-mail-alert-test.service'])
            self.assertEqual(kwargs['env']['CHAT_MAIL_ALERTS_ENABLED'], '0')
            return types.SimpleNamespace(stdout=json.dumps({'enabled': self.fail_probe}))
        c.subprocess = types.SimpleNamespace(check_output=command, run=run)
        c.pwd = types.SimpleNamespace(getpwnam=lambda _: types.SimpleNamespace(pw_name=m.ACCOUNT, pw_uid=10001, pw_gid=20001))
        c.shutil = types.SimpleNamespace(disk_usage=lambda _: types.SimpleNamespace(free=10 * 1024**3))
        c.runtime_executables = lambda: iter([str(self.node)] if self.runtime_active else [])
        self.original_groups = os.getgrouplist
        os.getgrouplist = lambda *args: [20001]
        self.addCleanup(setattr, os, 'getgrouplist', self.original_groups)

    def write(self, path, data, mode=0o600):
        path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data); path.chmod(mode)

    def run_upgrade(self):
        return self.m.upgrade(self.candidate, self.license)

    def test_success_preserves_armed_configuration_state_and_hooks(self):
        m = self.m; before = {str(p): p.read_bytes() for root in (m.CONFIG, m.STATE, m.UNIT_DIR) for p in root.rglob('*') if p.is_file()}
        original_inode = self.node.stat().st_ino
        result = self.run_upgrade()
        self.assertTrue(result['failureHooksPreserved']); self.assertTrue(result['disabledRuntimePassed'])
        self.assertFalse(result['mailSent']); self.assertFalse(result['servicesRestarted'])
        for name, data in before.items(): self.assertEqual(Path(name).read_bytes(), data)
        files = m.C.paths({'root': m.ROOT, 'config': m.CONFIG})
        self.assertEqual(self.node.read_bytes(), self.new); self.assertEqual((files['backup'] / 'node').read_bytes(), self.old)
        self.assertNotEqual((files['backup'] / 'node').stat().st_ino, original_inode)
        self.assertEqual(stat.S_IMODE(self.node.stat().st_mode), 0o550); self.assertEqual(self.node.stat().st_gid, 20001)
        self.assertEqual(files['receipt'].stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(ValueError, 'Prior attempt'): self.run_upgrade()

    def test_preflight_rejections_leave_runtime_and_operation_markers_unchanged(self):
        cases = ('bad-candidate', 'bad-license', 'busy-notifier', 'busy-worker', 'timer-enabled', 'unknown-instance',
            'active-runtime', 'bad-script', 'extra-software', 'changed-hook', 'changed-service', 'state-symlink',
            'state-owner', 'state-permissions', 'config-permissions', 'changed-provider-config', 'unarmed-config',
            'low-space', 'low-rollback-space', 'candidate-symlink', 'prior-attempt', 'node-hardlink')
        for case in cases:
            with self.subTest(case=case):
                # A fresh real filesystem for each negative case.
                child = AlertUpgradeTests('test_success_preserves_armed_configuration_state_and_hooks'); child.setUp()
                try:
                    m, c = child.m, child.m.C
                    if case == 'bad-candidate': child.candidate.write_bytes(b'bad')
                    elif case == 'bad-license': child.license.write_bytes(b'bad')
                    elif case == 'busy-notifier': child.busy = 'chat-mail-alert@chat-mail-inbound.service.service'
                    elif case == 'busy-worker': child.busy = 'chat-mail-inbound.service'
                    elif case == 'timer-enabled': child.busy = 'chat-mail-inbound.timer'
                    elif case == 'unknown-instance': child.unknown = True
                    elif case == 'active-runtime': child.runtime_active = True
                    elif case == 'bad-script': (m.ROOT / 'mail-operator-alert.mjs').write_bytes(b'changed')
                    elif case == 'extra-software': child.write(m.ROOT / 'extra', b'unknown')
                    elif case == 'changed-hook': (m.UNIT_DIR / 'chat-mail-inbound.service.d/50-operator-alert.conf').write_bytes(b'changed')
                    elif case == 'changed-service': (m.UNIT_DIR / 'chat-mail-alert@.service').write_bytes(b'changed')
                    elif case == 'state-symlink': (m.STATE / 'chat-mail-inbound.service.json').symlink_to(child.delivery)
                    elif case == 'state-owner': os.chown(child.delivery, 0, 0)
                    elif case == 'state-permissions': child.delivery.chmod(0o644)
                    elif case == 'config-permissions': (m.CONFIG / 'alerts.env').chmod(0o644)
                    elif case == 'changed-provider-config': (m.CONFIG / 'alerts.env').write_bytes(b'CHAT_MAIL_ALERTS_ENABLED=1\nunknown')
                    elif case == 'unarmed-config': (m.CONFIG / 'alerts.env').write_bytes((m.CONFIG / 'alerts.env.before-hooks').read_bytes())
                    elif case == 'low-space': c.shutil.disk_usage = lambda _: types.SimpleNamespace(free=0)
                    elif case == 'low-rollback-space': c.shutil.disk_usage = lambda path: types.SimpleNamespace(free=0 if path == m.CONFIG else 10 * 1024**3)
                    elif case == 'candidate-symlink': child.candidate.unlink(); child.candidate.symlink_to(child.node)
                    elif case == 'prior-attempt': child.write(c.paths({'root':m.ROOT, 'config':m.CONFIG})['attempt'], b'existing')
                    elif case == 'node-hardlink': os.link(child.node, child.base / 'linked')
                    with child.assertRaises((ValueError, OSError)): child.run_upgrade()
                    child.assertEqual(child.node.read_bytes(), child.old)
                    child.assertFalse(c.paths({'root': m.ROOT, 'config': m.CONFIG})['backup'].exists())
                    child.assertFalse(any(args[0] == '/usr/sbin/runuser' for args in child.calls))
                finally: child.doCleanups()

    def test_atomic_replacement_never_removes_the_executable_path(self):
        m = self.m; original = os.replace; observations = []
        def replace(source, dest):
            self.assertEqual(dest, self.node); self.assertEqual(dest.read_bytes(), self.old)
            original(source, dest); observations.append(dest.read_bytes())
        os.replace = replace
        try: self.run_upgrade()
        finally: os.replace = original
        self.assertEqual(observations, [self.new])

    def test_activity_during_preparation_holds_without_runtime_replacement(self):
        m = self.m; original = m.C.copy_candidate
        def changed(*args):
            original(*args); self.busy = 'chat-mail-alert@chat-mail-inbound.service.service'
        m.C.copy_candidate = changed
        with self.assertRaises(ValueError): self.run_upgrade()
        self.assertEqual(self.node.read_bytes(), self.old)
        with self.assertRaisesRegex(ValueError, 'Prior attempt'): self.run_upgrade()

    def test_failed_disabled_probe_keeps_new_runtime_and_original_rollback_for_review(self):
        self.fail_probe = True
        with self.assertRaisesRegex(ValueError, 'Disabled notifier'): self.run_upgrade()
        files = self.m.C.paths({'root': self.m.ROOT, 'config': self.m.CONFIG})
        self.assertEqual(self.node.read_bytes(), self.new); self.assertEqual((files['backup'] / 'node').read_bytes(), self.old)
        self.assertFalse(files['receipt'].exists())
        with self.assertRaisesRegex(ValueError, 'Prior attempt'): self.run_upgrade()

    def test_runtime_and_rollback_copies_are_verified_before_replacement_or_execution(self):
        for corrupted in ('candidate', 'backup'):
            with self.subTest(corrupted=corrupted):
                child = AlertUpgradeTests('test_success_preserves_armed_configuration_state_and_hooks'); child.setUp()
                try:
                    m = child.m; original = m.C.copy_candidate
                    def corrupt(*args):
                        original(*args)
                        files = m.C.paths({'root': m.ROOT, 'config': m.CONFIG})
                        (files['candidate'] if corrupted == 'candidate' else files['backup'] / 'node').write_bytes(b'changed')
                    m.C.copy_candidate = corrupt
                    with child.assertRaisesRegex(ValueError, 'Runtime copy integrity'): child.run_upgrade()
                    child.assertEqual(child.node.read_bytes(), child.old)
                    child.assertFalse(any(args[0] == '/usr/sbin/runuser' for args in child.calls))
                finally: child.doCleanups()

    def test_wrong_helper_or_symlink_is_rejected_before_loading(self):
        m = self.m
        m.COMMON_PATH = self.base / 'other-helper.py'; self.write(m.COMMON_PATH, b'raise RuntimeError("must not execute")')
        with self.assertRaisesRegex(ValueError, 'Reviewed helper differs'): m.load_common()
        m.COMMON_PATH.unlink(); m.COMMON_PATH.symlink_to(self.node)
        with self.assertRaises(OSError): m.load_common()

    def test_changed_configuration_during_preparation_holds_before_replacement(self):
        m = self.m; original = m.C.copy_candidate
        def changed(*args):
            original(*args); (m.CONFIG / 'alerts.env').write_bytes(b'changed after preflight')
        m.C.copy_candidate = changed
        with self.assertRaises(ValueError): self.run_upgrade()
        self.assertEqual(self.node.read_bytes(), self.old)
        self.assertFalse(any(args[0] == '/usr/sbin/runuser' for args in self.calls))

    def test_notification_starting_after_atomic_replacement_is_held_without_stopping_it(self):
        original = os.replace
        def replace(source, dest):
            original(source, dest); self.busy = 'chat-mail-alert@chat-mail-inbound.service.service'
        os.replace = replace
        try:
            with self.assertRaisesRegex(ValueError, 'Notifier is busy'): self.run_upgrade()
        finally: os.replace = original
        files = self.m.C.paths({'root': self.m.ROOT, 'config': self.m.CONFIG})
        self.assertEqual(self.node.read_bytes(), self.new); self.assertEqual((files['backup'] / 'node').read_bytes(), self.old)
        self.assertFalse(files['receipt'].exists())
        self.assertTrue(all(args[0] != '/usr/bin/systemctl' or args[1] in ('show', 'list-units') for args in self.calls))
        with self.assertRaisesRegex(ValueError, 'Prior attempt'): self.run_upgrade()

    def test_wrong_reported_runtime_version_never_records_success(self):
        self.fail_version = True
        with self.assertRaisesRegex(ValueError, 'Unexpected Node version'): self.run_upgrade()
        self.assertFalse(self.m.C.paths({'root': self.m.ROOT, 'config': self.m.CONFIG})['receipt'].exists())


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('Run only in the disposable root fixture environment.')
    unittest.main()
