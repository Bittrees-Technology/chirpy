import { createHash } from 'node:crypto';
import { buildGateHealthReport } from './ops-utils.js';
import { readGateClientConfig } from './gate-config.js';
import { getGatekeeperClient } from './gate-client.js';
import { gateWorkQueue } from './gate-queue.js';
import { loadRooms } from './room-join.js';
import { logEvent } from './server-utils.js';

export const gateRegistryHash = rooms => createHash('sha256').update(JSON.stringify(rooms)).digest('hex');

export async function probeMainnet(rpcUrl, { fetcher = fetch, now = Date.now, signal } = {}) {
  const call = async (method, params) => {
    const response = await fetcher(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('RPC unavailable.');
    const body = await response.json(); if (body.error) throw new Error('RPC unavailable.'); return body.result;
  };
  const [chainId, block] = await Promise.all([call('eth_chainId', []), call('eth_getBlockByNumber', ['latest', false])]);
  const timestamp = /^0x[0-9a-f]{1,16}$/i.test(block?.timestamp || '') ? Number(BigInt(block.timestamp)) * 1000 : NaN;
  if (chainId !== '0x1' || !Number.isSafeInteger(timestamp) || now() - timestamp > 300_000 || timestamp - now() > 60_000) throw new Error('RPC chain or block freshness is invalid.');
}

export function createGateProbe({ env = process.env, getClient = getGatekeeperClient, getRooms = loadRooms,
  workQueue = gateWorkQueue, fetcher = fetch, now = Date.now } = {}) {
  return async signal => {
    if (!buildGateHealthReport(env).ok) throw new Error('Gate configuration is incomplete.');
    readGateClientConfig(env);
    const rooms = await getRooms();
    if (!rooms.length) throw new Error('No managed rooms are configured.');
    const registryHash = gateRegistryHash(rooms);
    const xmtp = async () => {
      const bot = await workQueue.run(async () => { const client = await getClient(); await client.conversations.sync(); return client; });
      for (const room of rooms) {
        if (signal?.aborted) throw new Error('Probe stopped.');
        // Yield the queue between rooms so waiting admissions can run.
        await workQueue.run(async () => {
          const group = await bot.conversations.getConversationById(room.id);
          if (!group || typeof group.isSuperAdmin !== 'function') throw new Error('Managed room unavailable.');
          await group.sync(); if (!await group.isSuperAdmin(bot.inboxId)) throw new Error('Gatekeeper room authority unavailable.');
        });
      }
    };
    const results = await Promise.allSettled([probeMainnet(env.MAINNET_RPC_URL, { fetcher, now, signal }), xmtp()]);
    return { rpc: results[0].status === 'fulfilled', xmtp: results[1].status === 'fulfilled', registryHash };
  };
}

export function createGateDependencyMonitor({ probe = createGateProbe(), now = Date.now,
  intervalMs = 60_000, staleMs = 120_000, report = fields => logEvent('gate.dependencies', fields) } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 3600000 || !Number.isInteger(staleMs) || staleMs < intervalMs || staleMs > 3600000) throw new Error('Invalid dependency probe intervals.');
  let timer; let stopped = false; let running = false;
  const controller = new AbortController();
  let state = { ready: false, checkedAt: null, rpc: false, xmtp: false };
  const tick = async () => {
    if (stopped || running) return;
    running = true; const started = now();
    try { const checks = await probe(controller.signal); state = { ...checks, ready: checks.rpc === true && checks.xmtp === true, checkedAt: now() }; }
    catch { state = { ready: false, checkedAt: now(), rpc: false, xmtp: false }; }
    finally {
      running = false;
      if (!stopped) {
        try { report({ outcome: state.ready ? 'ready' : 'unready', durationMs: now() - started }); } catch { /* Reporting cannot disable probes. */ }
        timer = setTimeout(tick, intervalMs); timer.unref?.();
      }
    }
  };
  return {
    snapshot() {
      const age = state.checkedAt === null ? Infinity : now() - state.checkedAt;
      return { ...state, ready: !stopped && state.ready && age >= 0 && age <= staleMs, checking: running };
    },
    start() { if (!stopped && !running && !timer) { timer = setTimeout(tick, 0); timer.unref?.(); } },
    stop() { stopped = true; clearTimeout(timer); controller.abort(); },
  };
}
