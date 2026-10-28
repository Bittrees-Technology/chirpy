"""Offline observer boundaries; synthetic supervisor data, no systemd/SDK access."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('observer', Path(__file__).resolve().parents[1] / 'selfhost/mail-private-observer.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)
NOW = 1_000_000_000
WALL = 1_800_000_000_000
BOOT = 'a' * 32
INVOCATION = 'b' * 32


class Fixture:
    def __init__(self):
        self.calls = []
        self.properties = {}
        self.reports = {}
        for component, (service, timer) in observer.UNITS.items():
            self.properties[timer] = dict(Id=timer, LoadState='loaded', ActiveState='active', UnitFileState='enabled')
            self.properties[service] = dict(Id=service, LoadState='loaded', ActiveState='inactive', Result='success', ExecMainStatus='0', InvocationID=INVOCATION, ExecMainExitTimestampMonotonic=str(NOW - 1000))
            payload = dict(enabled=True, status='healthy', checkedAt=WALL, queue=dict(pending=0, due=0, expired=0, staleClaims=0, orphaned=0, corrupt=0, oldestAgeMs=0), worker=dict(lastAttemptAt=WALL-1000, lastSuccessAt=WALL-1000, lastOutcome='idle'), sender=dict(guarded=False, uncertain=False)) if component == 'inbound' else dict(enabled=True, status='ok', workerHealthy=True, providerBlocked=False, checkedAt=WALL, lastSuccessfulTickAt=WALL-1000, queued=0, due=0, oldestDueAgeMs=0, uncertainCount=0, processed=0)
            self.reports[component] = {'_SYSTEMD_UNIT': service, '_SYSTEMD_INVOCATION_ID': INVOCATION, '_BOOT_ID': BOOT, '__MONOTONIC_TIMESTAMP': str(NOW - 2000), 'MESSAGE': json.dumps(payload)}

    def run(self, argv):
        self.calls.append(argv)
        if argv[0] == '/usr/bin/systemctl':
            return '\n'.join(k + '=' + v for k, v in self.properties[argv[-1]].items()) + '\n'
        assert argv[0] == '/usr/bin/journalctl'
        component = next(k for k, (service, _) in observer.UNITS.items() if '_SYSTEMD_UNIT=' + service in argv)
        assert '_SYSTEMD_INVOCATION_ID=' + INVOCATION in argv
        return json.dumps(self.reports[component])

    def observe(self):
        return observer.observe(self.run, NOW, WALL, BOOT)


class ObserverTests(unittest.TestCase):
    def test_fresh_fixed_receipts(self):
        f = Fixture()
        result = f.observe()
        self.assertEqual(result['status'], 'healthy')
        self.assertEqual(len(f.calls), 6)
        self.assertTrue(all(c[0] in ('/usr/bin/systemctl', '/usr/bin/journalctl') for c in f.calls))
        self.assertTrue(all('show' in c or '--output=json' in c for c in f.calls))
        self.assertNotIn('MESSAGE', json.dumps(result))
        self.assertNotIn(INVOCATION, json.dumps(result))
        self.assertTrue(result['readOnly'])
        self.assertFalse(result['workerStarted'])

    def test_disabled_never_reads_health_logs(self):
        f = Fixture()
        for _, timer in observer.UNITS.values():
            f.properties[timer]['UnitFileState'] = 'disabled'
        self.assertEqual(f.observe()['status'], 'disabled')
        self.assertEqual(len(f.calls), 2)

    def test_default_success_is_not_execution(self):
        for patch in ({'InvocationID': ''}, {'ExecMainExitTimestampMonotonic': '0'}):
            with self.subTest(patch=patch):
                f = Fixture()
                f.properties[observer.UNITS['inbound'][0]].update(patch)
                self.assertEqual(f.observe()['status'], 'unavailable')

    def test_failed_running_missing_and_stale_supervisor(self):
        for patch, expected in [({'Result': 'exit-code'}, 'degraded'), ({'ExecMainStatus': '2'}, 'degraded'), ({'ActiveState': 'activating'}, 'degraded'), ({'LoadState': 'not-found'}, 'unavailable'), ({'ExecMainExitTimestampMonotonic': '1'}, 'unavailable'), ({'ExecMainExitTimestampMonotonic': str(NOW+1)}, 'unavailable')]:
            with self.subTest(patch=patch):
                f = Fixture()
                f.properties[observer.UNITS['inbound'][0]].update(patch)
                self.assertEqual(f.observe()['status'], expected)

    def test_foreign_stale_future_and_malformed_receipts(self):
        for key, value in [('_SYSTEMD_UNIT', 'other.service'), ('_SYSTEMD_INVOCATION_ID', 'c'*32), ('_BOOT_ID', 'd'*32), ('__MONOTONIC_TIMESTAMP', '1'), ('__MONOTONIC_TIMESTAMP', str(NOW+1)), ('MESSAGE', 'private non-JSON text'), ('MESSAGE', 'x'*4097), ('MESSAGE', ['multiple', 'values'])]:
            with self.subTest(key=key, value=str(value)[:40]):
                f = Fixture()
                f.reports['inbound'][key] = value
                result = f.observe()
                self.assertEqual(result['status'], 'unavailable')
                self.assertNotIn('private', json.dumps(result))

    def test_inconsistent_private_payloads_rejected_without_output(self):
        for component, patch in [('inbound', {'checkedAt': WALL-300001}), ('inbound', {'checkedAt': WALL+30001}), ('inbound', {'status': 'degraded'}), ('inbound', {'body': 'private body'}), ('outbound', {'workerHealthy': False}), ('outbound', {'processed': 2}), ('outbound', {'due': True})]:
            with self.subTest(component=component, patch=patch):
                f = Fixture()
                payload = json.loads(f.reports[component]['MESSAGE'])
                payload.update(patch)
                f.reports[component]['MESSAGE'] = json.dumps(payload)
                result = f.observe()
                self.assertEqual(result['status'], 'unavailable')
                self.assertNotIn('private body', json.dumps(result))

    def test_valid_disabled_and_degraded_payloads(self):
        f = Fixture()
        f.reports['inbound']['MESSAGE'] = json.dumps(dict(enabled=False, status='disabled'))
        self.assertEqual(f.observe()['status'], 'disabled')
        f = Fixture()
        payload = json.loads(f.reports['outbound']['MESSAGE'])
        payload.update(status='degraded', workerHealthy=False, providerBlocked=True)
        f.reports['outbound']['MESSAGE'] = json.dumps(payload)
        self.assertEqual(f.observe()['status'], 'degraded')

    def test_invalid_disabled_boolean_and_unhealthy_heartbeat_never_pass(self):
        f = Fixture()
        f.reports['inbound']['MESSAGE'] = '{"enabled":0,"status":"disabled"}'
        self.assertEqual(f.observe()['status'], 'unavailable')
        for component in observer.UNITS:
            f = Fixture()
            payload = json.loads(f.reports[component]['MESSAGE'])
            if component == 'inbound':
                payload['worker']['lastSuccessAt'] = WALL - 300001
            else:
                payload['lastSuccessfulTickAt'] = WALL - 300001
            f.reports[component]['MESSAGE'] = json.dumps(payload)
            self.assertEqual(f.observe()['status'], 'unavailable')

    def test_arguments_cannot_select_commands_or_units(self):
        import subprocess
        result = subprocess.run([sys.executable, '-I', str(Path(observer.__file__)), 'other.service'], capture_output=True, text=True, check=False, timeout=2)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['status'], 'unavailable')
        self.assertNotIn('other.service', result.stdout)
        self.assertEqual(result.stderr, '')

    def test_duplicate_properties_and_payload_fields_denied(self):
        f = Fixture()
        run = f.run
        self.assertEqual(observer.observe(lambda argv: run(argv) + '\nId=other' if argv[0].endswith('systemctl') else run(argv), NOW, WALL, BOOT)['status'], 'unavailable')
        f = Fixture()
        f.reports['inbound']['MESSAGE'] = '{"enabled":false,"status":"disabled","status":"healthy"}'
        self.assertEqual(f.observe()['status'], 'unavailable')

    def test_unavailable_permissions_and_errors_are_sanitized(self):
        def denied(_):
            raise PermissionError('private credential detail')
        result = observer.observe(denied, NOW, WALL, BOOT)
        self.assertEqual(result['status'], 'unavailable')
        self.assertNotIn('credential', json.dumps(result))

    def test_real_child_output_limit_and_deadline(self):
        with self.assertRaises(ValueError):
            observer.command([sys.executable, '-I', '-c', 'print("x"*10000)'], limit=128)
        with self.assertRaises(ValueError):
            observer.command([sys.executable, '-I', '-c', 'import time;time.sleep(10)'], timeout=0.05)
        self.assertEqual(observer.command([sys.executable, '-I', '-c', 'print("ok")']), 'ok\n')


if __name__ == '__main__':
    unittest.main()
