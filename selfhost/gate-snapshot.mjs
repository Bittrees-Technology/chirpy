// Integrity checks for an already offline, complete copy of the gate data directory.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MANIFEST = 'chirpy-snapshot.json';
const MAX_FILES = 10000;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function filesIn(directory) {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Snapshot must be a real directory.');
  const names = fs.readdirSync(directory).filter(name => name !== MANIFEST).sort();
  if (!names.length || names.length > MAX_FILES || !names.some(name => name.endsWith('.db3'))) throw new Error('Snapshot must contain a gate database and at most 10,000 files.');
  if (names.some(name => /[\\\0]/.test(name))) throw new Error('Snapshot filenames cannot contain path separators.');
  return names;
}
function openRegular(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Snapshot entries must be regular files without hard links.');
    return { fd, stat };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function fingerprint(directory, name) {
  const { fd, stat } = openRegular(path.join(directory, name));
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Snapshot changed while reading; stop all writers and copy again.');
    return { name, size: stat.size, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
export function sealSnapshot(directory) {
  const names = filesIn(directory);
  const manifest = { version: 1, files: names.map(name => fingerprint(directory, name)) };
  if (JSON.stringify(names) !== JSON.stringify(filesIn(directory))) throw new Error('Snapshot file list changed while reading.');
  const encoded = JSON.stringify(manifest, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > MAX_MANIFEST_BYTES) throw new Error('Snapshot manifest exceeds the supported size.');
  // Never replace an earlier integrity record, including a linked destination.
  const fd = fs.openSync(path.join(directory, MANIFEST), 'wx', 0o600);
  try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { manifest, manifestSha256: createHash('sha256').update(encoded).digest('hex') };
}
export function verifySnapshot(directory, expectedManifestSha256) {
  if (typeof expectedManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) throw new Error('Supply the manifest SHA-256 from the separately trusted recovery record.');
  const names = filesIn(directory);
  const { fd, stat } = openRegular(path.join(directory, MANIFEST));
  let manifest;
  try {
    if (stat.size > MAX_MANIFEST_BYTES) throw new Error('Snapshot manifest exceeds the supported size.');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length !== stat.size) throw new Error('Snapshot manifest changed while reading.');
    const encoded = buffer.subarray(0, length);
    if (createHash('sha256').update(encoded).digest('hex') !== expectedManifestSha256) throw new Error('Snapshot manifest does not match the trusted recovery record.');
    manifest = JSON.parse(encoded.toString('utf8'));
  } finally { fs.closeSync(fd); }
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== names.length) throw new Error('Snapshot manifest or file count is invalid.');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (typeof entry?.name !== 'string' || entry.name === MANIFEST || entry.name === '.' || entry.name === '..' || /[/\\\0]/.test(entry.name) || seen.has(entry.name) || !names.includes(entry.name) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Snapshot manifest entry is invalid.');
    seen.add(entry.name);
    const actual = fingerprint(directory, entry.name);
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error('Snapshot integrity check failed; preserve the original backup and investigate.');
  }
  if (JSON.stringify(names) !== JSON.stringify(filesIn(directory))) throw new Error('Snapshot file list changed while verifying.');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [action, directory, expectedHash, ...extra] = process.argv.slice(2);
    if (!directory || extra.length || !['seal', 'verify'].includes(action) || (action === 'seal' && expectedHash)) throw new Error('Usage: node selfhost/gate-snapshot.mjs seal <offline-snapshot-directory> | verify <directory> <trusted-manifest-sha256>');
    const result = action === 'seal' ? sealSnapshot(directory) : { manifest: verifySnapshot(directory, expectedHash) };
    console.log(`Snapshot ${action === 'seal' ? 'sealed' : 'verified'}: ${result.manifest.files.length} files. This does not verify key custody, database validity or live service readiness.`);
    if (result.manifestSha256) console.log(`Record separately: ${result.manifestSha256}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
