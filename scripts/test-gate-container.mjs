import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const image = process.argv[2];
if (!image) throw new Error('Pass the built test image name.');
const project = `chat-gate-test-${randomUUID()}`;
const directory = mkdtempSync(join(tmpdir(), 'chat-gate-compose-'));
let name;
const config = fileURLToPath(new URL('../selfhost/docker-compose.yml', import.meta.url));
// Exercise the shipped Compose file with isolated, credential-free fixtures.
writeFileSync(join(directory, 'gate.env'), 'GATE_PORT=0\nGATE_ALLOW_ORIGIN=https://chirpy.test\n', { mode: 0o600 });
writeFileSync(join(directory, 'rooms.json'), '[]\n', { mode: 0o644 });
writeFileSync(join(directory, 'image.json'), JSON.stringify({ services: { gate: { image } } }));
const compose = (...args) => execFileSync('docker', ['compose', '--project-name', project, '--project-directory', directory,
  '--env-file', join(directory, 'gate.env'), '-f', config, '-f', join(directory, 'image.json'), ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GATE_PORT: '0', GATE_BIND_HOST: '' } }).trim();
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
const run = () => { compose('up', '-d', '--no-build'); name = compose('ps', '-q', 'gate'); assert.ok(name); };
try {
  const rendered = JSON.parse(compose('config', '--format', 'json')).services.gate;
  assert.equal(rendered.ports.length, 1);
  assert.equal(rendered.ports[0].host_ip, '127.0.0.1');
  assert.equal(Number(rendered.ports[0].target), 8788);
  assert.equal(Number(rendered.ports[0].published), 0);
  assert.equal(String(rendered.environment.GATE_PORT), '8788');
  run();
  const bindings = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name));
  assert.deepEqual(Object.keys(bindings), ['8788/tcp']);
  assert.equal(bindings['8788/tcp'].length, 1);
  assert.equal(bindings['8788/tcp'][0].HostIp, '127.0.0.1');
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
  console.log('Gate Compose: loopback-only published port, independent host port, non-root, read-only root, no capabilities, no privilege escalation, native SDK, HTTP rejection, persistent volume and absence of shell/package managers passed.');
} finally {
  try { compose('down', '--volumes', '--remove-orphans'); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
