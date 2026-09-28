// Disposable Linux acceptance runner. Its runtime never reads deployment settings.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) !== 24 || process.argv.length !== 3 || process.argv[2] !== '--dev') {
  throw Error('Use Linux Node 24 and explicit --dev');
}
const root = mkdtempSync(join(tmpdir(), 'chat-mail-browser-dev-'));
const cleanEnv = { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'user.npmrc'), npm_config_globalconfig: join(root, 'global.npmrc') };
let complete = false;
try {
  writeFileSync(cleanEnv.npm_config_userconfig, '', { mode: 0o600 });
  writeFileSync(cleanEnv.npm_config_globalconfig, '', { mode: 0o600 });
  const archive = spawnSync('git', ['archive', '--format=tar', '--output', join(root, 'source.tar'), 'HEAD', 'server', 'packages/core'], { stdio: 'inherit' });
  if (archive.error || archive.status !== 0) throw Error('Source archive failed');
  const extract = spawnSync('tar', ['-xf', join(root, 'source.tar'), '-C', root], { stdio: 'inherit' });
  if (extract.error || extract.status !== 0) throw Error('Source extraction failed');
  cpSync('selfhost/mail-worker.package.json', join(root, 'package.json'));
  cpSync('selfhost/mail-worker.package-lock.json', join(root, 'package-lock.json'));
  cpSync('scripts/test-mail-browser-sender.mjs', join(root, 'sender.mjs'));
  const install = spawnSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, env: cleanEnv, stdio: 'inherit', timeout: 180_000 });
  if (install.error || install.status !== 0) throw Error('Isolated sender runtime installation failed');
  const test = spawnSync('pnpm', ['exec', 'playwright', 'test', 'tests/e2e/xmtp-mail-bridge.spec.ts', '--workers=1'], {
    stdio: 'inherit', timeout: 480_000,
    env: { ...process.env, XMTP_E2E: '1', VITE_TRANSPORT: 'xmtp', VITE_XMTP_ENV: 'dev', CHAT_TEST_BRIDGE_RUNTIME: root },
  });
  if (test.error || test.status !== 0) throw Error('Bridge-to-browser acceptance failed');
  complete = true;
} finally {
  // The supervised sender exits before Playwright returns. Only this fresh fixture
  // is removed; no deployment identity, mailbox or browser profile is accessed.
  if (complete) rmSync(root, { recursive: true, force: true });
  else console.error('Incomplete disposable fixture retained privately at ' + root);
}
