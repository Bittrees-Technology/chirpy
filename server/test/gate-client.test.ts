import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, lstat, stat, writeFile, readFile, chmod, symlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGateResumeConfig } from '../gate-resume-config.js';
import { readGateClientConfig } from '../gate-config.js';
import { createGateClientGetter, provisionGateInstallation } from '../gate-client.js';
import { buildGateHealthReport } from '../ops-utils.js';

const dirs: string[] = [];
const base = { XMTP_GATEKEEPER_PRIVATE_KEY: `0x${'1'.repeat(64)}`, GATE_DB_ENCRYPTION_KEY: '2'.repeat(64), GATE_DATA_DIR: '/data', GATE_XMTP_ENV: 'dev' };
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('persistent encrypted gate client', () => {
  it.each([
    { XMTP_GATEKEEPER_PRIVATE_KEY: '0xabc' },
    { XMTP_GATEKEEPER_PRIVATE_KEY: `0x${'0'.repeat(64)}` },
    { XMTP_GATEKEEPER_PRIVATE_KEY: `0x${'f'.repeat(64)}` },
    { GATE_DB_ENCRYPTION_KEY: '' }, { GATE_DB_ENCRYPTION_KEY: '0'.repeat(64) },
    { GATE_DB_ENCRYPTION_KEY: base.XMTP_GATEKEEPER_PRIVATE_KEY },
    { GATE_DATA_DIR: '' }, { GATE_DATA_DIR: 'relative' }, { GATE_XMTP_ENV: 'unknown' },
  ])('rejects unsafe configuration before loading the SDK: %j', async override => {
    const loadSdk = vi.fn();
    await expect(createGateClientGetter({ env: { ...base, ...override }, loadSdk })()).rejects.toThrow();
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('refuses a missing or empty store before loading the SDK or creating directories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'chat-gate-')); dirs.push(parent);
    const loadSdk = vi.fn();
    await expect(createGateClientGetter({ env: { ...base, GATE_DATA_DIR: join(parent, 'missing') }, loadSdk })()).rejects.toThrow();
    expect(loadSdk).not.toHaveBeenCalled();
    await expect(lstat(join(parent, 'missing'))).rejects.toThrow();
    await expect(createGateClientGetter({ env: { ...base, GATE_DATA_DIR: parent }, loadSdk })()).rejects.toThrow();
    expect(loadSdk).not.toHaveBeenCalled();
  });

  async function fixture() {
    const dataDir = await mkdtemp(join(tmpdir(), 'chat-gate-')); dirs.push(dataDir);
    const env = { ...base, GATE_DATA_DIR: dataDir };
    const client = { isRegistered: false, inboxId: 'a'.repeat(64), installationId: 'b'.repeat(64), register: vi.fn(async () => { client.isRegistered = true; }) };
    let options: any;
    const create = vi.fn(async (_signer, config) => {
      options = config;
      // Faithfully model SDK auto-registration instead of hiding its default.
      if (!config.disableAutoRegister) await client.register();
      await writeFile(config.dbPath(client.inboxId), 'encrypted synthetic database', { mode: 0o600 });
      return client;
    });
    const build = vi.fn(async (_identifier, config) => { options = config; config.dbPath(client.inboxId); return client; });
    const loadSdk = vi.fn(async () => ({ Client: { create, build }, IdentifierKind: { Ethereum: 0 }, LogLevel: { Off: 0 } }));
    return { dataDir, env, client, create, build, loadSdk, options: () => options };
  }

  it('resumes the recorded installation with public address and database key only', async () => {
    const f = await fixture(); await provisionGateInstallation(f);
    const address = readGateResumeConfig(f.env).address;
    const env = { ...f.env, XMTP_GATEKEEPER_ADDRESS: address.toUpperCase().replace('0X', '0x'), XMTP_GATEKEEPER_PRIVATE_KEY: '' };
    const parsed = readGateResumeConfig(env);
    expect(parsed.address).toBe(address); expect(parsed).not.toHaveProperty('privateKey');
    expect(await createGateClientGetter({ env, loadSdk: f.loadSdk })()).toBe(f.client);
    expect(f.build).toHaveBeenCalledTimes(1); expect(f.client.register).toHaveBeenCalledTimes(1);
    await expect(provisionGateInstallation({ env, loadSdk: f.loadSdk })).rejects.toThrow('key');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(readGateResumeConfig({ ...f.env, XMTP_GATEKEEPER_ADDRESS: address }).address).toBe(address);
  });

  it.each(['missing', 'zero', 'malformed', 'wrong', 'invalid-key'])('rejects %s public/legacy identity before SDK access', async kind => {
    const f = await fixture(); await provisionGateInstallation(f); f.loadSdk.mockClear();
    const env = { ...f.env, XMTP_GATEKEEPER_ADDRESS: readGateResumeConfig(f.env).address, XMTP_GATEKEEPER_PRIVATE_KEY: '' };
    if (kind === 'missing') env.XMTP_GATEKEEPER_ADDRESS = '';
    if (kind === 'zero') env.XMTP_GATEKEEPER_ADDRESS = '0x' + '0'.repeat(40);
    if (kind === 'malformed') env.XMTP_GATEKEEPER_ADDRESS += '\n';
    if (kind === 'wrong') env.XMTP_GATEKEEPER_ADDRESS = '0x' + '3'.repeat(40);
    if (kind === 'invalid-key') env.XMTP_GATEKEEPER_PRIVATE_KEY = 'invalid';
    await expect(createGateClientGetter({ env, loadSdk: f.loadSdk })()).rejects.toThrow();
    expect(f.loadSdk).not.toHaveBeenCalled(); expect(f.client.register).toHaveBeenCalledTimes(1);
  });

  it('rejects explicit public/signing disagreement before reserving bootstrap state', async () => {
    const f = await fixture(); const env = { ...f.env, XMTP_GATEKEEPER_ADDRESS: '0x' + '3'.repeat(40) };
    await expect(provisionGateInstallation({ env, loadSdk: f.loadSdk })).rejects.toThrow('conflicts');
    expect(f.loadSdk).not.toHaveBeenCalled();
    await expect(lstat(join(f.dataDir, 'chat-gate-registration-attempt.json'))).rejects.toThrow();
    expect(readGateResumeConfig(f.env)).not.toHaveProperty('privateKey');
  });

  it('provisions deliberately once, then resumes the same recorded installation without a signer', async () => {
    const f = await fixture();
    expect(await provisionGateInstallation(f)).toBe(f.client);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.client.register).toHaveBeenCalledTimes(1);
    expect(f.options().disableAutoRegister).toBe(true);
    expect((await stat(join(f.dataDir, 'chat-gate-registration-attempt.json'))).mode & 0o777).toBe(0o600);
    const getter = createGateClientGetter(f); const first = getter(); expect(getter()).toBe(first);
    expect(await first).toBe(f.client); expect(await getter()).toBe(f.client);
    expect(f.build).toHaveBeenCalledTimes(1); expect(f.client.register).toHaveBeenCalledTimes(1);
    expect(f.build.mock.calls[0][0]).toEqual({ identifier: expect.stringMatching(/^0x/), identifierKind: 0 });
    expect(f.options().dbEncryptionKey).toEqual(new Uint8Array(32).fill(0x22));
    expect(() => f.options().dbPath('../other')).toThrow();
    expect(() => f.options().dbPath('c'.repeat(64))).toThrow();
    await expect(provisionGateInstallation(f)).rejects.toThrow('not empty');
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'attempt', 'receipt'])('preserves %s state and refuses provisioning before SDK access', async kind => {
    const f = await fixture();
    const name = kind === 'attempt' ? 'chat-gate-registration-attempt.json' : kind === 'receipt' ? 'chat-gate-installation.json' : 'existing.db3';
    await writeFile(join(f.dataDir, name), 'preserve me', { mode: 0o600 });
    await expect(provisionGateInstallation(f)).rejects.toThrow('not empty');
    expect(await readFile(join(f.dataDir, name), 'utf8')).toBe('preserve me');
    expect(f.loadSdk).not.toHaveBeenCalled();
  });

  it('keeps an interrupted registration reserved and never automatically retries it', async () => {
    const f = await fixture(); f.client.register.mockRejectedValueOnce(new Error('uncertain publication'));
    await expect(provisionGateInstallation(f)).rejects.toThrow('uncertain');
    await expect(provisionGateInstallation(f)).rejects.toThrow('not empty');
    await expect(createGateClientGetter(f)()).rejects.toThrow();
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.build).not.toHaveBeenCalled();
    expect(f.client.register).toHaveBeenCalledTimes(1);
  });

  it.each(['wallet', 'network', 'key', 'database', 'receipt', 'installation', 'unregistered'])('refuses changed %s instead of re-registering', async kind => {
    const f = await fixture(); await provisionGateInstallation(f); f.loadSdk.mockClear();
    const original = await readFile(join(f.dataDir, 'chat-gate-installation.json'), 'utf8');
    if (kind === 'wallet') f.env.XMTP_GATEKEEPER_PRIVATE_KEY = '0x' + '3'.repeat(64);
    if (kind === 'network') f.env.GATE_XMTP_ENV = 'production';
    if (kind === 'key') f.env.GATE_DB_ENCRYPTION_KEY = '4'.repeat(64);
    if (kind === 'database') await rm(join(f.dataDir, `chirpy-xmtp-gatekeeper-${f.client.inboxId}.db3`));
    if (kind === 'receipt') await rm(join(f.dataDir, 'chat-gate-installation.json'));
    if (kind === 'installation') f.client.installationId = 'c'.repeat(64);
    if (kind === 'unregistered') f.client.isRegistered = false;
    await expect(createGateClientGetter(f)()).rejects.toThrow();
    expect(f.client.register).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1);
    if (!['installation', 'unregistered'].includes(kind)) expect(f.loadSdk).not.toHaveBeenCalled();
    if (kind !== 'receipt') expect(await readFile(join(f.dataDir, 'chat-gate-installation.json'), 'utf8')).toBe(original);
  });

  it.each(['directory', 'database', 'receipt', 'hardlink', 'permissions', 'sidecar'])('rejects unsafe %s storage without SDK access', async kind => {
    const f = await fixture(); await provisionGateInstallation(f); f.loadSdk.mockClear();
    let env = f.env;
    const db = join(f.dataDir, `chirpy-xmtp-gatekeeper-${f.client.inboxId}.db3`);
    const receipt = join(f.dataDir, 'chat-gate-installation.json');
    if (kind === 'directory') { const alias = f.dataDir + '-alias'; dirs.push(alias); await symlink(f.dataDir, alias); env = { ...env, GATE_DATA_DIR: alias }; }
    if (kind === 'database') { await rename(db, db + '-saved'); await symlink(db + '-saved', db); }
    if (kind === 'receipt') { await rename(receipt, receipt + '-saved'); await symlink(receipt + '-saved', receipt); }
    if (kind === 'hardlink') await link(db, join(f.dataDir, 'alias'));
    if (kind === 'permissions') await chmod(f.dataDir, 0o755);
    if (kind === 'sidecar') await symlink(db, db + '-wal');
    await expect(createGateClientGetter({ env, loadSdk: f.loadSdk })()).rejects.toThrow();
    expect(f.loadSdk).not.toHaveBeenCalled();
  });

  it('only reserves one concurrent provision and holds an SDK import failure', async () => {
    const f = await fixture();
    f.loadSdk.mockRejectedValue(new Error('SDK unavailable'));
    const results = await Promise.allSettled([provisionGateInstallation(f), provisionGateInstallation(f)]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(f.loadSdk).toHaveBeenCalledTimes(1);
    await expect(provisionGateInstallation(f)).rejects.toThrow('not empty');
    expect(f.loadSdk).toHaveBeenCalledTimes(1);
  });

  it.each(['oversized', 'malformed', 'public', 'empty-db'])('holds %s receipt/database evidence before loading SDK', async kind => {
    const f = await fixture(); await provisionGateInstallation(f); f.loadSdk.mockClear();
    const receipt = join(f.dataDir, 'chat-gate-installation.json');
    if (kind === 'oversized') await writeFile(receipt, ' '.repeat(4097));
    if (kind === 'malformed') await writeFile(receipt, '{');
    if (kind === 'public') await chmod(receipt, 0o644);
    if (kind === 'empty-db') await writeFile(join(f.dataDir, `chirpy-xmtp-gatekeeper-${f.client.inboxId}.db3`), '');
    await expect(createGateClientGetter(f)()).rejects.toThrow();
    expect(f.loadSdk).not.toHaveBeenCalled();
  });

  it('allows a read-only SDK initialization retry without another registration', async () => {
    const f = await fixture(); await provisionGateInstallation(f);
    f.build.mockRejectedValueOnce(new Error('unavailable'));
    const getter = createGateClientGetter(f);
    await expect(getter()).rejects.toThrow('unavailable');
    expect(await getter()).toBe(f.client); expect(f.build).toHaveBeenCalledTimes(2);
    expect(f.client.register).toHaveBeenCalledTimes(1);
  });

  it('reports missing durable storage without exposing secrets', () => {
    const report = buildGateHealthReport({ ...base, GATE_DB_ENCRYPTION_KEY: '', GATE_DATA_DIR: '' });
    expect(report.ok).toBe(false);
    for (const name of ['database-key', 'data-directory']) expect(report.checks.find(check => check.name === name)?.status).toBe('degraded');
    expect(JSON.stringify(buildGateHealthReport(base))).not.toContain(base.GATE_DB_ENCRYPTION_KEY);
    expect(JSON.stringify(buildGateHealthReport(base))).not.toContain(base.XMTP_GATEKEEPER_PRIVATE_KEY);
    expect(readGateClientConfig({ ...base, GATE_XMTP_ENV: '' }).network).toBe('production');
  });
});
