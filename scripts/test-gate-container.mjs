import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const image = process.argv[2];
if (!image) throw new Error('Pass the built test image name.');
const suffix = randomUUID(); const name = `chirpy-gate-test-${suffix}`; const volume = `${name}-data`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const node = script => docker('exec', name, 'node', '--input-type=module', '-e', script);
// Keep a referenced deadline through body consumption so a pending fetch cannot
// end the test process before finally cleans up its container and volume.
async function request(url, options = {}) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  } finally { clearTimeout(deadline); }
}
const run = () => docker('run', '-d', '--name', name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
  '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '-p', '127.0.0.1::8788', '-v', `${volume}:/data`, '-e', 'GATE_ALLOW_ORIGIN=https://chirpy.test', image);
try {
  docker('volume', 'create', volume); run();
  const port = docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "8788/tcp") 0).HostPort}}', name);
  const url = `http://127.0.0.1:${port}`;
  let response;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { response = await request(`${url}/health`); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert.ok(response, 'Gate must start under restricted permissions');
  assert.equal(response.status, 503); assert.equal(JSON.parse(response.body).ok, false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  response = await request(`${url}/api/room-join`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.test' }, body: '{}' });
  assert.equal(response.status, 403);
  response = await request(`${url}/api/room-join`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://chirpy.test' }, body: '{' });
  assert.equal(response.status, 400);
  node(`import assert from 'node:assert/strict'; import fs from 'node:fs'; import { Client } from '@xmtp/node-sdk';
    assert.equal(process.getuid(), 65532); assert.equal(typeof Client.create, 'function');
    assert.match(fs.readFileSync('/proc/self/status','utf8'), /CapEff:\\s+0+\\n/);
    assert.match(fs.readFileSync('/proc/self/status','utf8'), /NoNewPrivs:\\s+1/);
    assert.equal(fs.statSync('/home/nonroot').uid, 65532);
    assert.throws(() => fs.writeFileSync('/home/nonroot/forbidden-test-write', 'no'), error => error.code === 'EROFS');
    fs.writeFileSync('/data/persistence-probe', 'synthetic persistence check');`);
  assert.throws(() => docker('exec', name, 'npm', '--version'));
  assert.throws(() => docker('exec', name, 'sh', '-c', 'true'));
  node(`import fs from 'node:fs'; if (!fs.existsSync('/etc/ssl/certs/ca-certificates.crt')) throw new Error('System TLS CA bundle missing');`);
  docker('stop', name); docker('rm', name); run();
  node(`import assert from 'node:assert/strict'; import fs from 'node:fs'; assert.equal(fs.readFileSync('/data/persistence-probe','utf8'), 'synthetic persistence check');`);
  console.log('Gate container: non-root, read-only root, no capabilities, no privilege escalation, native SDK, HTTP rejection, persistent volume and absence of shell/package managers passed.');
} finally {
  try { docker('rm', '-f', name); } catch { /* Startup may have failed before creation. */ }
  try { docker('volume', 'rm', volume); } catch (error) { console.error('Test volume cleanup failed:', volume); throw error; }
}
