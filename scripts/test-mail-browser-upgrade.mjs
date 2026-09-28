// An old build is served only on loopback to disposable Playwright contexts.
// Keep the exact shipped artifact available for same-origin database continuity.
import { mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const BASELINE = 'b452499bbfac2f00a9c622d49d189af704f33d44';
if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) !== 24 || process.argv.length !== 3 || process.argv[2] !== '--dev') throw Error('Use Linux Node 24 and explicit --dev');
const root = mkdtempSync(join(tmpdir(), 'chat-previous-browser-dev-'));
const env = { ...process.env, XMTP_E2E: '1', VITE_TRANSPORT: 'xmtp', VITE_XMTP_ENV: 'dev', PLAYWRIGHT_PORT: '1420' };
function run(command, args, cwd = root, timeout = 240_000) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', timeout });
  if (result.error || result.status !== 0) throw Error('Previous-build acceptance preparation failed');
}
let server, complete = false;
const fd = openSync(join(root, 'preview.log'), 'wx', 0o600);
try {
  if (spawnSync('git', ['cat-file', '-e', BASELINE + '^{commit}']).status !== 0) run('git', ['fetch', '--depth=1', 'origin', BASELINE], process.cwd());
  run('git', ['archive', '--format=tar', '--output', join(root, 'source.tar'), BASELINE], process.cwd());
  run('tar', ['-xf', join(root, 'source.tar'), '-C', root]);
  run('pnpm', ['install', '--frozen-lockfile']);
  run('pnpm', ['--filter', '@app/web', 'build']);
  if (await fetch('http://127.0.0.1:1421', { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false)) throw Error('Previous-build port already in use');
  server = spawn('pnpm', ['--filter', '@app/web', 'preview', '--host', '127.0.0.1', '--port', '1421', '--strictPort'], { cwd: root, env, stdio: ['ignore', fd, fd], detached: true });
  let serverError;
  server.on('error', error => { serverError = error; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (serverError || server.exitCode !== null) throw Error('Previous-build server failed');
    if (await fetch('http://127.0.0.1:1421', { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false)) break;
    if (Date.now() > deadline) throw Error('Previous-build server did not become ready');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const result = spawnSync(process.execPath, ['scripts/test-mail-browser-bridge.mjs', '--dev'], {
    env: { ...env, CHAT_TEST_PREVIOUS_URL: 'http://127.0.0.1:1421' }, stdio: 'inherit', timeout: 900_000,
  });
  if (result.error || result.status !== 0) throw Error('Existing browser compatibility failed');
  complete = true;
} finally {
  // Stop only the dedicated process group created above, never a user browser.
  if (server?.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  closeSync(fd);
  if (complete) rmSync(root, { recursive: true, force: true });
  else console.error('Incomplete previous-build fixture retained privately at ' + root);
}
