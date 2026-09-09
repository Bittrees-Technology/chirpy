// Explicit dev-network recovery drill. Uses only a fresh synthetic identity.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const image = process.argv[2];
if (!image || process.env.XMTP_STORAGE_DRILL !== '1') throw new Error('Set XMTP_STORAGE_DRILL=1 and pass a built gate image to run this dev-network drill.');
const prefix = `chirpy-storage-${randomUUID()}`;
const volumes = ['source', 'restore', 'wrong-key'].map(suffix => `${prefix}-${suffix}`);
const key = `0x${randomBytes(32).toString('hex')}`;
const databaseKey = randomBytes(32).toString('hex');
const message = `synthetic recovery ${randomUUID()}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function run(volume, script, input, extra = []) {
  const container = `${prefix}-worker`;
  try {
    return execFileSync('docker', ['run', '--rm', '--name', container, '-i', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '-v', `${volume}:/data`, ...extra, image, '--input-type=module', '-e', script], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    // Do not print child input or SDK diagnostics containing identity material.
    const diagnostic = String(error.stderr || '').replaceAll(key, '[redacted]').replaceAll(databaseKey, '[redacted]').replace(/(?:0x)?[a-fA-F0-9]{64}/g, '[redacted]');
    throw new Error(`Storage drill child failed (status ${error.status ?? 'timeout'}): ${diagnostic.slice(-2000)}`);
  } finally {
    try { docker(['rm', '-f', container]); } catch { /* Successful --rm runs are already removed. */ }
  }
}
const prelude = `import assert from 'node:assert/strict'; import fs from 'node:fs';
import { createGateClientGetter } from './server/gate-client.js';
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
const get = createGateClientGetter({ env: { XMTP_GATEKEEPER_PRIVATE_KEY: data.key, GATE_DB_ENCRYPTION_KEY: data.databaseKey, GATE_DATA_DIR: '/data', GATE_XMTP_ENV: 'dev' } });`;
try {
  for (const volume of volumes) docker(['volume', 'create', volume]);
  const result = run(volumes[0], `${prelude}
const client = await get(); const group = await client.conversations.createGroup([]); await group.sendText(data.message);
console.log(JSON.stringify({ inbox: client.inboxId, installation: client.installationId, group: group.id })); process.exit(0);`, { key, databaseKey, message });
  const identity = JSON.parse(result.split('\n').at(-1));
  // Each writer process has exited before sealing or copying its snapshot.
  const sealed = run(volumes[0], `import { sealSnapshot, verifySnapshot } from './selfhost/gate-snapshot.mjs';
const result = sealSnapshot('/data'); verifySnapshot('/data', result.manifestSha256); console.log(result.manifestSha256);`, {});
  const manifestSha256 = sealed.split('\n').at(-1);
  // Each writer process has exited before a snapshot is copied. Both destinations are new volumes.
  for (const target of volumes.slice(1)) run(target, `import fs from 'node:fs'; import assert from 'node:assert/strict'; import { createHash } from 'node:crypto'; import { DatabaseSync } from 'node:sqlite'; import { verifySnapshot } from './selfhost/gate-snapshot.mjs';
const input = JSON.parse(fs.readFileSync(0,'utf8'));
verifySnapshot('/backup', input.manifestSha256);
const files = fs.readdirSync('/backup'); assert.ok(files.some(name => name.endsWith('.db3')));
assert.equal(fs.readdirSync('/data').length, 0);
for (const name of files) { const source = '/backup/' + name; assert.ok(fs.lstatSync(source).isFile());
const bytes = fs.readFileSync(source); // SQLCipher intentionally leaves a 32-byte SQLite header readable. Querying the schema without a key must still fail.
if (name.endsWith('.db3')) { const db = new DatabaseSync(source, { readOnly: true }); try { assert.throws(() => db.prepare('SELECT count(*) FROM sqlite_master').get()); } finally { db.close(); } }
assert.ok(!bytes.includes(Buffer.from(input.message)));
fs.copyFileSync(source, '/data/' + name);
assert.equal(createHash('sha256').update(fs.readFileSync('/data/' + name)).digest('hex'), createHash('sha256').update(bytes).digest('hex')); }
verifySnapshot('/data', input.manifestSha256);
// Keep the integrity record in the original backup, outside the active database.
fs.unlinkSync('/data/chirpy-snapshot.json'); console.log('snapshot verified');`, { message, manifestSha256 }, ['-v', `${volumes[0]}:/backup:ro`]);
  const restored = run(volumes[1], `${prelude}
const client = await get(); assert.equal(client.inboxId, data.inbox); assert.equal(client.installationId, data.installation);
const group = await client.conversations.getConversationById(data.group); assert.ok(group);
assert.ok((await group.messages()).some(item => item.content === data.message));
console.log('restored identity and local messages'); process.exit(0);`, { key, databaseKey, message, ...identity });
  assert.ok(restored.includes('restored identity'));
  const rejected = run(volumes[2], `${prelude}
await assert.rejects(get()); console.log('wrong key rejected'); process.exit(0);`, { key, databaseKey: randomBytes(32).toString('hex') });
  assert.ok(rejected.includes('wrong key rejected'));
  console.log('XMTP dev storage drill passed: encrypted bytes, offline snapshot integrity, fresh-volume restore, same installation and local message, wrong-key rejection.');
} finally {
  for (const volume of volumes) docker(['volume', 'rm', volume]);
}
