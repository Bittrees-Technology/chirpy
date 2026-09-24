"""Host-independent installer boundary tests; no root account or service changes."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer', SOURCE / 'selfhost/install-mail-outbound.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationBoundary(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.archive = self.root / 'input.tar'
        self.payload = self.root / 'payload'
        self.payload.mkdir()
        self.metadata = {'version': 1, 'commit': 'a' * 40, 'tree': 'b' * 40}
        self.files = {name: b'fixture' for name in installer.REQUIRED}
        self.files['bundle.json'] = json.dumps(self.metadata).encode()
        for name in installer.UNIT_NAMES:
            self.files['release/selfhost/systemd/' + name] = (SOURCE / 'selfhost/systemd' / name).read_bytes()

    def bundle(self, extra=()):
        with tarfile.open(self.archive, 'w') as archive:
            for name, data in self.files.items():
                member = tarfile.TarInfo(name)
                member.mode = 0o755 if name == 'runtime/bin/node' else 0o644
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            for member in extra:
                archive.addfile(member, io.BytesIO(b''))
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def verify(self, expected=None):
        digest = expected or self.bundle()
        snapshot = self.root / 'snapshot.tar'
        installer.snapshot(self.archive, snapshot, digest)
        return installer.extract(snapshot, self.payload)

    def test_valid_snapshot_discards_archive_write_permissions(self):
        self.assertEqual(self.verify(), self.metadata)
        self.assertEqual((self.payload / 'runtime/bin/node').stat().st_mode & 0o7777, 0o500)
        self.assertEqual((self.payload / 'release/package.json').stat().st_mode & 0o7777, 0o400)

    def test_wrong_digest_stops_before_extract(self):
        self.bundle()
        with self.assertRaises(ValueError):
            self.verify('0' * 64)
        self.assertEqual(list(self.payload.iterdir()), [])

    def test_changing_source_after_snapshot_does_not_change_installation(self):
        digest = self.bundle()
        copied = self.root / 'copied.tar'
        installer.snapshot(self.archive, copied, digest)
        self.archive.write_bytes(b'changed after snapshot')
        self.assertEqual(installer.extract(copied, self.payload), self.metadata)

    def test_reject_symlink_source(self):
        digest = self.bundle()
        link = self.root / 'link.tar'
        link.symlink_to(self.archive)
        with self.assertRaises(OSError):
            installer.snapshot(link, self.root / 'copied', digest)

    def test_reject_fifo_source_without_blocking(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        with self.assertRaises(ValueError):
            installer.snapshot(fifo, self.root / 'copied', '0' * 64)

    def test_reject_overlarge_snapshot(self):
        digest = self.bundle()
        with patch.object(installer, 'MAX_ARCHIVE', 1), self.assertRaises(ValueError):
            self.verify(digest)

    def test_forbid_archive_traversal_and_ambiguous_names(self):
        for index, name in enumerate(('/tmp/escape', '../escape', 'release/../../escape',
                                      'release/./escape', 'release//escape', 'other/file',
                                      'release/back\\slash', 'release/line\nname')):
            with self.subTest(name=name):
                self.bundle([tarfile.TarInfo(name)])
                destination = self.root / str(index)
                destination.mkdir()
                with self.assertRaises(ValueError):
                    installer.extract(self.archive, destination)
        self.assertFalse((self.root / 'escape').exists())

    def test_forbid_links_devices_and_fifos(self):
        for index, kind in enumerate((tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE,
                                      tarfile.BLKTYPE, tarfile.FIFOTYPE)):
            with self.subTest(kind=kind):
                member = tarfile.TarInfo('release/evil')
                member.type, member.linkname = kind, '/etc/passwd'
                self.bundle([member])
                destination = self.root / str(index)
                destination.mkdir()
                with self.assertRaises(ValueError):
                    installer.extract(self.archive, destination)

    def test_forbid_duplicate_file(self):
        self.bundle([tarfile.TarInfo('release/package.json')])
        with self.assertRaises(ValueError):
            installer.extract(self.archive, self.payload)

    def test_expansion_limit(self):
        self.bundle()
        with patch.object(installer, 'MAX_EXPANDED', 1), self.assertRaises(ValueError):
            installer.extract(self.archive, self.payload)

    def test_entry_limit(self):
        self.bundle()
        with patch.object(installer, 'MAX_ENTRIES', 1), self.assertRaises(ValueError):
            installer.extract(self.archive, self.payload)

    def test_required_runtime_manifest_and_unit_files(self):
        for index, missing in enumerate(sorted(installer.REQUIRED)):
            with self.subTest(missing=missing):
                content = self.files.pop(missing)
                self.bundle()
                self.files[missing] = content
                destination = self.root / str(index)
                destination.mkdir()
                with self.assertRaises(ValueError):
                    installer.extract(self.archive, destination)

    def test_runtime_manifest_must_match_source(self):
        self.files['release/package-lock.json'] = b'changed dependencies'
        with self.assertRaises(ValueError):
            self.verify()

    def test_provenance_required(self):
        self.files['bundle.json'] = b'{"version":1,"commit":"main","tree":"unknown"}'
        with self.assertRaises(ValueError):
            self.verify()

    def test_installed_files_remain_disabled_without_secrets_or_journal(self):
        self.verify()
        target, config, state, units = [self.root / name for name in ('opt', 'etc', 'state', 'units')]
        units.mkdir()
        commands = []
        identity = type('Account', (), {'pw_uid': os.getuid(), 'pw_gid': os.getgid()})()
        # Actual filesystem install with only privileged ownership/account/systemd calls mocked.
        with patch.multiple(installer, TARGET=target, CONFIG=config, STATE=state, UNITS=units), \
             patch.object(installer.pwd, 'getpwnam', return_value=identity), \
             patch.object(installer.os, 'chown'), \
             patch.object(installer, 'run', side_effect=lambda *args: commands.append(args)):
            installer.install(self.payload, self.metadata, 'c' * 64)
        self.assertTrue((target / 'runtime/bin/node').exists())
        self.assertEqual((target / 'release/package.json').stat().st_mode & 0o777, 0o440)
        self.assertEqual(config.stat().st_mode & 0o777, 0o700)
        self.assertEqual((config / 'worker.env').stat().st_mode & 0o777, 0o600)
        self.assertEqual(state.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(state.iterdir()), [])
        environment = dict(line.split('=', 1) for line in (config / 'worker.env').read_text().splitlines() if '=' in line)
        for flag in ('CHAT_MAIL_OUTBOUND_WORKER_ENABLED', 'CHIRPY_MAIL_ENABLED'):
            self.assertEqual(environment[flag], '0')
        for key in ('CHIRPY_MAIL_FROM', 'CHAT_SMTP_JOURNAL_KEY', 'CHIRPY_MAIL_IDENTITY_SECRET',
                    'KV_REST_API_TOKEN', 'CHAT_SMTP_JOURNAL_ID', 'CHAT_SMTP_PROFILE'):
            self.assertEqual(environment[key], '')
        self.assertFalse(any(arg in ('start', 'enable', 'restart', 'npm') for command in commands for arg in command))
        self.assertEqual(commands[-1], ('/usr/bin/systemctl', 'daemon-reload'))
        self.assertEqual(json.loads((config / 'install-receipt.json').read_text())['bundleSha256'], 'c' * 64)
        for name in installer.UNIT_NAMES:
            self.assertEqual((units / name).read_bytes(), (SOURCE / 'selfhost/systemd' / name).read_bytes())

    def test_existing_paths_including_dangling_links_stop_before_mutation(self):
        parent = self.root / 'protected'
        parent.mkdir(mode=0o700)
        target = parent / 'existing'
        target.symlink_to(parent / 'missing')
        # Reach the real existence check independently of this unprivileged host's ownership.
        owner = parent.stat()
        protected = type('Stat', (), {'st_mode': owner.st_mode, 'st_uid': 0})()
        original = Path.lstat
        with patch.multiple(installer, TARGET=target, CONFIG=parent / 'config', STATE=parent / 'state', UNITS=parent), \
             patch.object(installer.os, 'geteuid', return_value=0), \
             patch.object(Path, 'lstat', lambda p: protected if p == parent else original(p)), \
             patch.object(installer, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'Existing installation'):
                installer.preflight()
            run.assert_not_called()

    @unittest.skipUnless(Path('/usr/bin/systemd-analyze').exists(), 'Requires Linux systemd tools')
    def test_actual_systemd_unit_verification(self):
        for name in installer.UNIT_NAMES:
            content = (SOURCE / 'selfhost/systemd' / name).read_text()
            content = content.replace('/opt/chat-mail-outbound/runtime/bin/node', '/usr/bin/true')
            (self.root / name).write_text(content)
        result = subprocess.run(['/usr/bin/systemd-analyze', 'verify', '--man=no', '--generators=no',
                                 *(str(self.root / name) for name in installer.UNIT_NAMES)],
                                capture_output=True, text=True, env=installer.COMMAND_ENV)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
