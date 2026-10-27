#!/usr/bin/env python3
"""Disposable Linux root filesystem fixtures. Never use production roots/services."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'selfhost/upgrade-mail-node.py'
OLD = b'old fixture runtime'
NEW = b'new fixture runtime' * 70000  # More than one copy chunk.
LICENSE = b'fixture license'
sha = lambda value: hashlib.sha256(value).hexdigest()

class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(), 0, 'Use disposable Linux CI/container root')
        self.assertEqual(sys.platform, 'linux')
        self.assertTrue(os.environ.get('GITHUB_ACTIONS') == 'true' or Path('/.dockerenv').exists())
        self.temp = tempfile.TemporaryDirectory(prefix='.chat-node-upgrade-test-', dir='/opt')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        spec = importlib.util.spec_from_file_location('node_upgrade_fixture', SCRIPT)
        self.m = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.m)
        m = self.m
        m.OLD_SHA, m.NEW_SHA, m.NEW_BYTES, m.LICENSE_SHA = sha(OLD), sha(NEW), len(NEW), sha(LICENSE)
        self.candidate, self.license = self.base/'candidate', self.base/'LICENSE'
        self.candidate.write_bytes(NEW); self.license.write_bytes(LICENSE)
        self.manifests = {}
        self.expected = {'inbound': '1'*40, 'api-scheduler': '2'*40}
        self.selected = ('inbound', 'api-scheduler')
        self.components = copy.deepcopy(m.COMPONENTS)
        for name, c in self.components.items():
            c['root'] = self.base/name
            c['config'] = self.base/(name+'-config')
            c['lock'] = self.base/(name+'.lock')
            c['state'] = self.base/'sender-state' if name == 'inbound' else None
            c['root'].mkdir(mode=0o750); c['config'].mkdir(mode=0o700)
            c['lock'].write_bytes(b''); c['lock'].chmod(0o600)
            (c['config']/'worker.env').write_text(c['flag']+'=0\nSECRET=fixture-only\n')
            (c['config']/'worker.env').chmod(0o600)
            files = {'runtime/bin/node': OLD, c['script']: b'fixture script: not executed'}
            if c['state'] is not None:
                files['release/node_modules/nodemailer/package.json'] = b'{"name":"nodemailer","version":"10.1.4"}'
                c['state'].mkdir(mode=0o700)
                (c['state']/'journal').write_bytes(b'original fixture journal')
                (c['state']/'journal').chmod(0o644)
                os.chown(c['state']/'journal', 65534, 65534)
            for relative, data in files.items():
                p = c['root']/relative; p.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
                p.write_bytes(data); p.chmod(0o550 if relative == 'runtime/bin/node' else 0o440)
                if relative == 'runtime/bin/node': os.chown(p, 0, 20001)
            bundle = {'commit': self.expected[name], 'files': {n: sha(v) for n,v in files.items()}, 'sourceOverlays': ['preserved']}
            (c['root']/'bundle.json').write_text(json.dumps(bundle)); (c['root']/'bundle.json').chmod(0o440)
            self.manifests[name] = sha((c['root']/'bundle.json').read_bytes())
        m.COMPONENTS = self.components
        self.calls = []
        self.fail_smoke = False
        self.active = None
        def check_output(args, **kwargs):
            self.assertEqual(args[:2], ['/usr/bin/systemctl', 'show'])
            name = args[2]
            return ('ActiveState='+('active' if self.active == name else 'inactive')+'\nUnitFileState='+
                    ('static' if name.endswith('.service') else 'disabled')+'\nFragmentPath=/fixture/'+name+'\nDropInPaths=/fixture/alerts.conf\nNeedDaemonReload=no\n')
        def run(args, **kwargs):
            self.assertEqual(args[0], '/usr/sbin/runuser')
            self.calls.append(args)
            if args[-1] == '--version': return types.SimpleNamespace(stdout='v'+m.VERSION+'\n')
            if args[-1] == '--once':
                name = 'inbound' if 'inbound' in args[-2] else 'api-scheduler'
                data = {'enabled': True} if self.fail_smoke else self.components[name]['disabled']
                return types.SimpleNamespace(stdout=json.dumps(data).encode())
            self.assertIn('--input-type=module', args)
            return types.SimpleNamespace(stdout=b'')
        m.subprocess = types.SimpleNamespace(check_output=check_output, run=run)
        m.pwd = types.SimpleNamespace(getpwnam=lambda name: types.SimpleNamespace(pw_name='fixture', pw_uid=10001, pw_gid=20001))
        m.shutil = types.SimpleNamespace(disk_usage=lambda path: types.SimpleNamespace(free=10*1024**3))

    def run_upgrade(self):
        return self.m.upgrade(self.selected, self.candidate, self.license, self.expected, self.manifests)

    def filesystem(self):
        values = {}
        for p in sorted(self.base.rglob('*')):
            s = p.lstat()
            values[str(p.relative_to(self.base))] = (s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode), p.read_bytes() if p.is_file() else None)
        return values

    def refuses_without_change(self, exception=ValueError):
        before = self.filesystem()
        with self.assertRaises(exception): self.run_upgrade()
        self.assertEqual(self.filesystem(), before)
        self.assertEqual(self.calls, [])

    def test_success_preserves_originals_and_nonroot_state(self):
        before = self.m.snapshot(self.components['inbound']['state'], root_owned=False)
        result = self.run_upgrade()
        self.assertTrue(result['upgraded']); self.assertFalse(result['mailSent'])
        self.assertEqual(len(self.calls), 5)
        for name, c in self.components.items():
            paths = self.m.paths(c)
            self.assertEqual(paths['node'].read_bytes(), NEW)
            self.assertEqual((paths['backup']/'node').read_bytes(), OLD)
            self.assertEqual(stat.S_IMODE(paths['node'].stat().st_mode), 0o550)
            self.assertEqual(json.loads(paths['bundle'].read_bytes())['sourceOverlays'], ['preserved'])
            self.assertEqual(json.loads(paths['receipt'].read_bytes())['baseCommit'], self.expected[name])
            self.assertEqual(json.loads(paths['attempt'].read_bytes())['neverAutomaticallyRetry'], True)
        self.assertEqual(self.m.snapshot(self.components['inbound']['state'], root_owned=False), before)
        self.assertEqual((self.components['inbound']['state']/'journal').stat().st_uid, 65534)
        held = self.filesystem()
        with self.assertRaises(ValueError): self.run_upgrade()
        self.assertEqual(self.filesystem(), held)

    def test_tampered_candidate(self):
        self.candidate.write_bytes(b'wrong'); self.refuses_without_change()
    def test_symlink_candidate(self):
        self.candidate.unlink(); self.candidate.symlink_to(self.license)
        self.refuses_without_change()
    def test_wrong_license(self):
        self.license.write_bytes(b'wrong'); self.refuses_without_change()
    def test_changed_second_runtime_prevents_first_update(self):
        p = self.components['api-scheduler']['root']/'runtime/bin/node'
        p.chmod(0o750); p.write_bytes(b'tampered'); p.chmod(0o550)
        self.refuses_without_change()
    def test_unknown_base_commit(self):
        self.expected['api-scheduler'] = '3'*40; self.refuses_without_change()
    def test_wrong_reviewed_manifest(self):
        self.manifests['api-scheduler'] = '3'*64; self.refuses_without_change()
    def test_enabled_worker(self):
        c = self.components['inbound']; (c['config']/'worker.env').write_text(c['flag']+'=1\n')
        self.refuses_without_change()
    def test_duplicate_conflicting_enable_flag(self):
        c = self.components['inbound']; (c['config']/'worker.env').write_text(c['flag']+'=0\n'+c['flag']+'=1\n')
        self.refuses_without_change()
    def test_active_unit(self):
        self.active = 'chat-mail-api-scheduler.service'; self.refuses_without_change()
    def test_active_deleted_runtime(self):
        self.m.runtime_executables = lambda: iter([str(self.components['inbound']['root']/'runtime/bin/node')+' (deleted)'])
        self.refuses_without_change()
    def test_process_inspection_unavailable(self):
        def unavailable(): raise PermissionError('fixture inspection denied')
        self.m.runtime_executables = unavailable; self.refuses_without_change(PermissionError)
    def test_low_space(self):
        self.m.shutil.disk_usage = lambda path: types.SimpleNamespace(free=1)
        self.refuses_without_change()
    def test_dependency_patch_required(self):
        c = self.components['inbound']; p = c['root']/'release/node_modules/nodemailer/package.json'
        p.chmod(0o640); p.write_bytes(b'{"name":"nodemailer","version":"10.0.9"}'); p.chmod(0o440)
        bundle = c['root']/'bundle.json'; data = json.loads(bundle.read_bytes()); data['files']['release/node_modules/nodemailer/package.json'] = sha(p.read_bytes())
        bundle.chmod(0o640); bundle.write_text(json.dumps(data)); bundle.chmod(0o440)
        self.manifests['inbound'] = sha(bundle.read_bytes())
        self.refuses_without_change()
    def test_unsafe_parent_permissions(self):
        self.components['inbound']['root'].chmod(0o777); self.refuses_without_change()
    def test_unexpected_file(self):
        (self.components['api-scheduler']['root']/'unexpected').write_bytes(b'hold'); self.refuses_without_change()
    def test_setuid_runtime_is_rejected(self):
        (self.components['inbound']['root']/'runtime/bin/node').chmod(0o4550); self.refuses_without_change()
    def test_root_service_account_is_rejected(self):
        self.m.pwd.getpwnam = lambda name: types.SimpleNamespace(pw_name='fixture', pw_uid=0, pw_gid=20001)
        self.refuses_without_change()
    def test_existing_candidate(self):
        self.m.paths(self.components['api-scheduler'])['candidate'].write_bytes(b'prior operation')
        self.refuses_without_change()
    def test_partial_replacement_keeps_backups_and_refuses_replay(self):
        original = self.m.replace_metadata
        def interrupted(*args): raise RuntimeError('fixture interrupted before metadata replacement')
        self.m.replace_metadata = interrupted
        with self.assertRaises(RuntimeError): self.run_upgrade()
        first = self.m.paths(self.components['inbound']); second = self.m.paths(self.components['api-scheduler'])
        self.assertEqual(first['node'].read_bytes(), NEW)
        self.assertEqual((first['backup']/'node').read_bytes(), OLD)
        self.assertEqual(second['node'].read_bytes(), OLD)
        self.assertTrue(second['candidate'].exists())
        self.assertTrue(first['attempt'].exists() and second['attempt'].exists())
        self.assertFalse(first['receipt'].exists() or second['receipt'].exists())
        self.m.replace_metadata = original
        self.refuses_without_change()
    def test_failed_smoke_holds_both_updated_runtimes_without_success_receipts(self):
        self.fail_smoke = True
        with self.assertRaises(ValueError): self.run_upgrade()
        for c in self.components.values():
            paths = self.m.paths(c)
            self.assertEqual(paths['node'].read_bytes(), NEW)
            self.assertEqual((paths['backup']/'node').read_bytes(), OLD)
            self.assertFalse(paths['receipt'].exists())
        self.calls.clear(); self.refuses_without_change()

if __name__ == '__main__':
    unittest.main()
