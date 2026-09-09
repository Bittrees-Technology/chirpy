import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGateClientConfig } from '../gate-config.js';
import { createGateClientGetter } from '../gate-client.js';
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

  it('shares initialization, uses the persistent key, and rejects path traversal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chirpy-gate-test-')); dirs.push(dataDir);
    const register = vi.fn(async () => {});
    let options: any;
    const client = { isRegistered: false, register };
    const create = vi.fn(async (_signer, config) => { options = config; return client; });
    const getter = createGateClientGetter({ env: { ...base, GATE_DATA_DIR: dataDir }, loadSdk: async () => ({ Client: { create }, IdentifierKind: { Ethereum: 0 }, LogLevel: { Off: 0 } }) });
    const first = getter(); expect(getter()).toBe(first);
    expect(await first).toBe(client); expect(await getter()).toBe(client);
    expect(create).toHaveBeenCalledTimes(1); expect(register).toHaveBeenCalledTimes(1);
    expect(options.dbEncryptionKey).toEqual(new Uint8Array(32).fill(0x22));
    expect(options.env).toBe('dev');
    expect(options.dbPath('abc123')).toBe(join(dataDir, 'chirpy-xmtp-gatekeeper-abc123.db3'));
    expect(() => options.dbPath('../other')).toThrow();
  });

  it('allows a retry only after initialization has failed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chirpy-gate-test-')); dirs.push(dataDir);
    const client = { isRegistered: true };
    const create = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(client);
    const getter = createGateClientGetter({ env: { ...base, GATE_DATA_DIR: dataDir }, loadSdk: async () => ({ Client: { create }, IdentifierKind: { Ethereum: 0 }, LogLevel: { Off: 0 } }) });
    await expect(getter()).rejects.toThrow('unavailable');
    expect(await getter()).toBe(client); expect(create).toHaveBeenCalledTimes(2);
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
