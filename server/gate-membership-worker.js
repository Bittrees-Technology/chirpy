import { createMembershipRevalidator } from './gate-membership.js';
import { getGatekeeperClient } from './gate-client.js';
import { gateWorkQueue } from './gate-queue.js';
import { loadRooms } from './room-join.js';
import { makeViemChainReader } from '../packages/core/src/viemChainReader.ts';
import { logEvent } from './server-utils.js';

export function startMembershipWorker({ env = process.env, getClient = getGatekeeperClient, getRooms = loadRooms,
  reader = () => makeViemChainReader(env.MAINNET_RPC_URL), workQueue = gateWorkQueue,
  report = counts => logEvent('membership.revalidation', counts) } = {}) {
  const mode = env.GATE_MEMBERSHIP_MODE || 'off';
  if (mode === 'off') return () => {};
  if (!['audit', 'enforce'].includes(mode)) throw new Error('GATE_MEMBERSHIP_MODE must be off, audit or enforce.');
  const revalidator = createMembershipRevalidator({ getClient, getRooms, reader, workQueue, mode });
  let stopped = false; let timer; let roomIndex = 0;
  const offsets = new Map();
  const tick = async () => {
    const counts = { mode, checked: 0, removed: 0, wouldRemove: 0, unknown: 0 };
    try {
      const rooms = await getRooms();
      for (const id of offsets.keys()) if (!rooms.some(room => room.id === id)) offsets.delete(id);
      if (rooms.length) {
        const room = rooms[roomIndex++ % rooms.length];
        const inboxIds = await workQueue.run(async () => {
          const bot = await getClient(); await bot.conversations.sync();
          const group = await bot.conversations.getConversationById(room.id);
          if (!group || typeof group.members !== 'function') throw new Error('Room unavailable.');
          await group.sync(); const members = await group.members();
          if (members.length > 10_000) throw new Error('Room exceeds maintenance limit.');
          const start = (offsets.get(room.id) || 0) % Math.max(1, members.length);
          const batch = members.slice(start, start + 25).map(member => member.inboxId);
          offsets.set(room.id, start + batch.length); return batch;
        });
        for (const inboxId of inboxIds) {
          if (stopped) break;
          const result = await revalidator.checkMember(room.id, inboxId); counts.checked++;
          if (result.status === 'removed') counts.removed++;
          if (result.status === 'would-remove') counts.wouldRemove++;
          if (result.status === 'unknown') counts.unknown++;
        }
      }
    } catch { counts.unknown++; }
    try { report(counts); } catch { /* Reporting failures must not terminate maintenance. */ }
    if (!stopped) { timer = setTimeout(tick, 60_000); timer.unref?.(); }
  };
  timer = setTimeout(tick, 5_000); timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
