import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateDependencyMonitor, createGateProbe, probeMainnet, gateRegistryHash } from '../gate-health.js';
import { createGateServer } from '../../selfhost/gate-server.mjs';
const env = { XMTP_GATEKEEPER_PRIVATE_KEY: `0x${'1'.repeat(64)}`, GATE_DB_ENCRYPTION_KEY: '2'.repeat(64), GATE_DATA_DIR: '/data', MAINNET_RPC_URL: 'https://rpc.example', GATE_PUBLIC_URL: 'https://gate.example/api/room-join', CHIRPY_GATE_ROOMS_FILE: '/rooms.json', GATE_ALLOW_ORIGIN: 'https://chirpy.example' };
const rpc = (chain = '0x1', timestamp = '0x3e8') => vi.fn(async (_url, options) => ({ ok: true, json: async () => ({ result: JSON.parse(options.body).method === 'eth_chainId' ? chain : { timestamp } }) }));
afterEach(() => vi.useRealTimers());
describe('live gate dependency readiness', () => {
  it('requires mainnet and a recent nonfuture block', async () => {
    await expect(probeMainnet(env.MAINNET_RPC_URL, { fetcher: rpc(), now: () => 1000000 })).resolves.toBeUndefined();
    for (const fetcher of [rpc('0x2'), rpc('0x1', '0x1'), rpc('0x1', '0xffffff')]) await expect(probeMainnet(env.MAINNET_RPC_URL, { fetcher, now: () => 1000000 })).rejects.toThrow();
    const fetcher = rpc(); await probeMainnet(env.MAINNET_RPC_URL, { fetcher, now: () => 1000000 });
    expect(fetcher).toHaveBeenCalledWith(env.MAINNET_RPC_URL, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });
  it('checks every managed room and preserves a failed dependency result', async () => {
    const group = { sync: vi.fn(), isSuperAdmin: vi.fn(() => true) };
    const client = { inboxId: 'bot', conversations: { sync: vi.fn(), getConversationById: vi.fn(async () => group) } };
    const probe = createGateProbe({ env, getClient: async () => client, getRooms: async () => [{ id: 'one' }, { id: 'two' }], fetcher: rpc(), now: () => 1000000 });
    expect(await probe()).toMatchObject({ rpc: true, xmtp: true }); expect(group.sync).toHaveBeenCalledTimes(2);
    group.isSuperAdmin.mockReturnValue(false); expect(await probe()).toMatchObject({ rpc: true, xmtp: false });
    const getClient = vi.fn();
    await expect(createGateProbe({ env: { ...env, GATE_PUBLIC_URL: 'https://gate.example/wrong' }, getClient })()).rejects.toThrow('configuration');
    await expect(createGateProbe({ env: {}, getClient })()).rejects.toThrow('configuration'); expect(getClient).not.toHaveBeenCalled();
    await expect(createGateProbe({ env, getClient, getRooms: async () => [] })()).rejects.toThrow('managed rooms'); expect(getClient).not.toHaveBeenCalled();
  });
  it('starts unready, expires stale success and never overlaps a hung probe', async () => {
    vi.useFakeTimers(); let finish!: (value: any) => void;
    const probe = vi.fn().mockResolvedValueOnce({ rpc: true, xmtp: true }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const monitor = createGateDependencyMonitor({ probe, intervalMs: 100, staleMs: 200, report: vi.fn() });
    expect(monitor.snapshot().ready).toBe(false); monitor.start(); monitor.start();
    await vi.advanceTimersByTimeAsync(1); expect(monitor.snapshot().ready).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); expect(probe).toHaveBeenCalledTimes(2); expect(monitor.snapshot().ready).toBe(false);
    monitor.stop(); finish({ rpc: true, xmtp: true }); await vi.advanceTimersByTimeAsync(1); expect(monitor.snapshot().ready).toBe(false);
  });
  it('reports dependency failures without leaking details and recovers on a later pass', async () => {
    vi.useFakeTimers(); const report = vi.fn();
    const probe = vi.fn().mockRejectedValueOnce(new Error('secret diagnostic')).mockResolvedValueOnce({ rpc: true, xmtp: true });
    const monitor = createGateDependencyMonitor({ probe, report, intervalMs: 100, staleMs: 200 }); monitor.start();
    await vi.advanceTimersByTimeAsync(1); expect(monitor.snapshot().ready).toBe(false); expect(JSON.stringify(monitor.snapshot())).not.toContain('secret');
    await vi.advanceTimersByTimeAsync(100); expect(monitor.snapshot().ready).toBe(true); monitor.stop();
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret');
  });
  it('serves 503 until dependencies pass, then returns to 503 when they fail', async () => {
    let ready = false; const rooms = [{ id: 'one' }]; const registryHash = gateRegistryHash(rooms);
    const server = createGateServer({ env, registry: async () => rooms, dependencySnapshot: () => ({ ready, checkedAt: Date.now(), registryHash }) });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as any).port}/health`;
      expect((await fetch(url)).status).toBe(503); ready = true;
      const healthy = await fetch(url); expect(healthy.status).toBe(200); expect((await healthy.json()).network).toBe('production');
      rooms.push({ id: 'new-room' }); expect((await fetch(url)).status).toBe(503);
      rooms.pop(); ready = false; expect((await fetch(url)).status).toBe(503);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
