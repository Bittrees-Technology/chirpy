import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createDisplayWallets } from '../display-wallet.js';
const container = process.env.CHIRPY_TEST_REDIS_CONTAINER, exec = promisify(execFile);
describe.skipIf(!container)('real Redis display-wallet choices', () => {
  const wallet = '0x' + '1'.repeat(40), target = '0x' + '2'.repeat(40), inboxId = 'a'.repeat(64), service = 'https://chat.example/api/profile?kind=display-wallet';
  const keys = new Set<string>();
  const kv = async (args: any[]) => {
    if (args[0] === 'EVAL') keys.add(args[3]);
    const { stdout } = await exec('docker', ['exec', container!, 'redis-cli', '--json', ...args.map(String)]);
    const result = JSON.parse(stdout); if (typeof result === 'string' && result.startsWith('ERR ')) throw Error(result); return result;
  };
  afterEach(async () => { if (keys.size) await kv(['DEL', ...keys]); keys.clear(); });
  it('admits one competing choice, resets without stale resurrection, and isolates networks', async () => {
    const config = { service, prefix: 'chat:display-wallet:test:' + randomBytes(8).toString('hex') + ':' }, api = createDisplayWallets(config, kv);
    const command = { version: 1, wallet, service, network: 'dev', inboxId, displayWallet: target, revision: 0, expiresAt: Date.now() + 60000 };
    const results = await Promise.all([api.write(command), api.write({ ...command, displayWallet: wallet })]);
    expect(results.map(result => result.status).sort()).toEqual(['conflict', 'saved']);
    expect(await api.write({ ...command, revision: 1, displayWallet: null })).toMatchObject({ status: 'saved', choice: { displayWallet: null, revision: 2 } });
    expect(await api.write(command)).toEqual({ status: 'conflict' });
    const [reset] = await api.readMany([wallet], 'dev'); expect(reset).toMatchObject({ inboxId, displayWallet: null, revision: 2 });
    expect((await api.readMany([wallet], 'production'))[0]).toMatchObject({ revision: 0, displayWallet: null, inboxId: null });
    expect((await api.write({ ...command, network: 'production' })).status).toBe('saved');
    const raw = await kv(['GET', config.prefix + 'dev:' + wallet]); expect(raw).toContain('"displayWallet":null'); expect(raw).not.toContain(target);
    expect(await kv(['TTL', config.prefix + 'dev:' + wallet])).toBe(-1);
  });
  it('preserves the full replay revision and refuses to replace invalid prior data', async () => {
    const config = { service, prefix: 'chat:display-wallet:test:' + randomBytes(8).toString('hex') + ':' }, api = createDisplayWallets(config, kv), key = config.prefix + 'dev:' + wallet;
    keys.add(key); await kv(['SET', key, JSON.stringify({ version: 1, wallet, network: 'dev', inboxId, displayWallet: null, revision: Number.MAX_SAFE_INTEGER - 2, updatedAt: 1 })]);
    const command = { version: 1, wallet, service, network: 'dev', inboxId, displayWallet: target, revision: Number.MAX_SAFE_INTEGER - 2, expiresAt: Date.now() + 60000 };
    expect(await api.write(command)).toMatchObject({ status: 'saved', choice: { revision: Number.MAX_SAFE_INTEGER - 1 } });
    expect(await kv(['GET', key])).toContain('"revision":9007199254740990');
    await kv(['SET', key, 'preserved invalid bytes']);
    await expect(api.write({ ...command, revision: 0 })).rejects.toThrow('Invalid display choice storage');
    expect(await kv(['GET', key])).toBe('preserved invalid bytes');
  });
});
