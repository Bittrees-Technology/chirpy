import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sealSnapshot, verifySnapshot, MANIFEST } from '../../selfhost/gate-snapshot.mjs';

const directories: string[] = [];
function verify(root: string) {
  const digest = createHash('sha256').update(fs.readFileSync(path.join(root, MANIFEST))).digest('hex');
  return verifySnapshot(root, digest);
}
function snapshot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chirpy-snapshot-test-'));
  directories.push(root);
  fs.writeFileSync(path.join(root, 'store.db3'), 'synthetic encrypted database bytes');
  fs.writeFileSync(path.join(root, 'store.db3-wal'), 'synthetic sidecar');
  fs.writeFileSync(path.join(root, 'store.db3.salt'), 'synthetic salt');
  return root;
}
afterEach(() => { for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('seals every file, creates a private manifest, and verifies an unchanged snapshot', () => {
  const root = snapshot();
  const { manifest } = sealSnapshot(root);
  expect(manifest.files.map(file => file.name)).toEqual(['store.db3', 'store.db3-wal', 'store.db3.salt']);
  expect(fs.statSync(path.join(root, MANIFEST)).mode & 0o777).toBe(0o600);
  expect(verify(root)).toEqual(manifest);
  expect(() => sealSnapshot(root)).toThrow();
});
it.each(['store.db3', 'store.db3-wal', 'store.db3.salt'])('rejects an altered %s', name => {
  const root = snapshot(); sealSnapshot(root);
  const file = path.join(root, name);
  const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  expect(() => verify(root)).toThrow('integrity');
});
it.each(['missing', 'extra'])('rejects %s snapshot files', mode => {
  const root = snapshot(); sealSnapshot(root);
  if (mode === 'missing') fs.unlinkSync(path.join(root, 'store.db3.salt'));
  else fs.writeFileSync(path.join(root, 'unexpected'), 'extra');
  expect(() => verify(root)).toThrow();
});
it.each(['symlink', 'hardlink', 'directory', 'fifo'])('rejects %s entries without opening a data stream', kind => {
  const root = snapshot(); const other = snapshot();
  const entry = path.join(root, 'unsafe');
  if (kind === 'symlink') fs.symlinkSync(path.join(other, 'store.db3'), entry);
  if (kind === 'hardlink') fs.linkSync(path.join(other, 'store.db3'), entry);
  if (kind === 'directory') fs.mkdirSync(entry);
  if (kind === 'fifo') execFileSync('mkfifo', [entry]);
  expect(() => sealSnapshot(root)).toThrow();
  expect(fs.existsSync(path.join(root, MANIFEST))).toBe(false);
});
it('rejects a symlinked manifest and leaves its target untouched', () => {
  const root = snapshot(); const other = snapshot(); const target = path.join(other, 'store.db3');
  fs.symlinkSync(target, path.join(root, MANIFEST));
  expect(() => sealSnapshot(root)).toThrow();
  expect(() => verify(root)).toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('synthetic encrypted database bytes');
});
it.each(['path', 'duplicate', 'version', 'size', 'hash', 'oversize'])('rejects a malformed manifest: %s', fault => {
  const root = snapshot(); const { manifest } = sealSnapshot(root);
  if (fault === 'path') manifest.files[0].name = '../outside';
  if (fault === 'duplicate') manifest.files[1] = manifest.files[0];
  if (fault === 'version') manifest.version = 2;
  if (fault === 'size') manifest.files[0].size = -1;
  if (fault === 'hash') manifest.files[0].sha256 = 'not-a-hash';
  fs.writeFileSync(path.join(root, MANIFEST), fault === 'oversize' ? ' '.repeat(1024 * 1024 + 1) : JSON.stringify(manifest));
  expect(() => verify(root)).toThrow();
});

it('rejects replacement of both database and manifest against a trusted recovery digest', () => {
  const root = snapshot(); const original = sealSnapshot(root);
  fs.unlinkSync(path.join(root, MANIFEST));
  fs.writeFileSync(path.join(root, 'store.db3'), 'replacement');
  sealSnapshot(root);
  expect(() => verifySnapshot(root, original.manifestSha256)).toThrow('trusted recovery record');
  expect(() => verifySnapshot(root, undefined)).toThrow('separately trusted');
});

it('runs the operator CLI and refuses verification without the trusted digest', () => {
  const root = snapshot();
  const script = fileURLToPath(new URL('../../selfhost/gate-snapshot.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script, 'seal', root], { encoding: 'utf8' });
  const digest = output.match(/Record separately: ([a-f0-9]{64})/)?.[1];
  expect(digest).toBeTruthy();
  expect(execFileSync(process.execPath, [script, 'verify', root, digest!], { encoding: 'utf8' })).toContain('Snapshot verified: 3 files');
  expect(() => execFileSync(process.execPath, [script, 'verify', root], { stdio: 'pipe' })).toThrow();
});
