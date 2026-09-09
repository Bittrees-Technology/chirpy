import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGate } from '../../selfhost/configure-gate.mjs';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'chirpy-installer-')); dirs.push(dir);
  const registry = join(dir, 'reviewed.json');
  await writeFile(registry, JSON.stringify([{ id: 'room-one', namespace: 'acme', title: 'Members', chainId: 1, gate: { combine: 'all', rules: [{ kind: 'token', standard: 'erc721', token: `0x${'1'.repeat(40)}`, min: '1' }] } }]));
  return { dir, env: { GATE_SETUP_DOMAIN: 'gate.example.org', GATE_SETUP_ORIGIN: 'https://chirpy.example.org', GATE_SETUP_RPC: 'https://rpc.example.org', GATE_SETUP_REGISTRY: registry } };
}
describe('gate installer', () => {
  it('creates distinct persistent keys and a readable read-only-mount registry', async () => {
    const { dir, env } = await setup();
    expect(await configureGate(env, dir)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const contents = await readFile(join(dir, 'gate.env'), 'utf8');
    expect(contents).toContain("GATE_DATA_DIR='/data'");
    expect(contents).toContain("CHIRPY_GATE_ROOMS_FILE='/config/rooms.json'");
    expect(contents).toContain("GATE_PUBLIC_URL='https://gate.example.org/api/room-join'");
    const wallet = contents.match(/XMTP_GATEKEEPER_PRIVATE_KEY='0x([a-f0-9]{64})'/)?.[1];
    const database = contents.match(/GATE_DB_ENCRYPTION_KEY='([a-f0-9]{64})'/)?.[1];
    expect(wallet).toBeTruthy(); expect(database).toBeTruthy(); expect(wallet).not.toBe(database);
    expect((await stat(join(dir, 'gate.env'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'rooms.json'))).mode & 0o777).toBe(0o644);
    await expect(configureGate(env, dir)).rejects.toThrow('overwritten');
    expect(await readFile(join(dir, 'gate.env'), 'utf8')).toBe(contents);
  });
  it.each([{ GATE_SETUP_DOMAIN: 'bad\nINJECT=1' }, { GATE_SETUP_ORIGIN: 'https://example.org/path' }, { GATE_SETUP_RPC: "https://rpc.example.org/'secret" }])('rejects unsafe config before writing secrets: %j', async override => {
    const { dir, env } = await setup();
    await expect(configureGate({ ...env, ...override }, dir)).rejects.toThrow();
    await expect(stat(join(dir, 'gate.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects unreviewed/empty registries and preserves dangling symlinks', async () => {
    const { dir, env } = await setup();
    await writeFile(env.GATE_SETUP_REGISTRY, '[]');
    await expect(configureGate(env, dir)).rejects.toThrow('reviewed registry');
    await symlink(join(dir, 'missing'), join(dir, 'gate.env'));
    await expect(configureGate(env, dir)).rejects.toThrow('overwritten');
  });
});
