import { evalGate, validateProductionGate } from '../packages/core/src/gating.ts';
import { createGateWorkQueue } from './gate-queue.js';

// Admission fails closed on read errors; eviction must instead preserve membership.
export async function membershipEligibility(gate, address, reader) {
  if (!validateProductionGate(gate)) return 'unknown';
  let failed = false;
  const observed = new Proxy(reader, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      return async (...args) => {
        try { return await value.apply(target, args); }
        catch (error) { failed = true; throw error; }
      };
    },
  });
  try {
    const eligible = await evalGate(gate, address, observed, { roleCascade: {}, powerTier: null });
    return eligible ? 'eligible' : failed ? 'unknown' : 'ineligible';
  } catch { return 'unknown'; }
}

const addressesOf = member => {
  const identifiers = member?.accountIdentifiers;
  if (!Array.isArray(identifiers) || !identifiers.length || identifiers.length > 32) return null;
  // Mixed/unsupported account types remain unknown rather than being evicted.
  if (identifiers.some(item => item.identifierKind !== 0 || !/^0x[0-9a-fA-F]{40}$/.test(item.identifier))) return null;
  return [...new Set(identifiers.map(item => item.identifier.toLowerCase()))].sort();
};

export function createMembershipRevalidator({ getClient, getRooms, reader, mode = 'audit',
  workQueue = createGateWorkQueue(), now = Date.now, observationMs = 300_000 } = {}) {
  if (!['audit', 'enforce'].includes(mode) || !Number.isInteger(observationMs) || observationMs < 300_000) throw new Error('Invalid membership revalidation configuration.');
  const observations = new Map();
  const forget = (key, status) => { observations.delete(key); return { status }; };
  const protectedMember = async (group, botId, inboxId) => inboxId === botId || await group.isAdmin(inboxId) || await group.isSuperAdmin(inboxId);
  return {
    async checkMember(roomId, inboxId) {
      const key = `${roomId}:${inboxId}`;
      try {
        return await workQueue.run(async () => {
          const rooms = await getRooms(); const room = rooms.find(item => item.id === roomId);
          if (!room || !validateProductionGate(room.gate)) return forget(key, 'unknown');
          const policy = JSON.stringify(room);
          const bot = await getClient();
          const group = await bot.conversations.getConversationById(roomId);
          if (!group || typeof group.removeMembers !== 'function' || typeof group.isAdmin !== 'function' || typeof group.isSuperAdmin !== 'function') return forget(key, 'unknown');
          await group.sync();
          if (!await group.isSuperAdmin(bot.inboxId)) return forget(key, 'unknown');
          if (await protectedMember(group, bot.inboxId, inboxId)) return forget(key, 'protected');
          const member = (await group.members()).find(item => item.inboxId === inboxId);
          if (!member) return forget(key, 'absent');
          const addresses = addressesOf(member);
          if (!addresses) return forget(key, 'unknown');
          let unknown = false;
          for (const address of addresses) {
            const bound = await bot.fetchInboxIdByIdentifier({ identifier: address, identifierKind: 0 });
            if (bound !== inboxId) { unknown = true; continue; }
            const decision = await membershipEligibility(room.gate, address, reader());
            if (decision === 'eligible') return forget(key, 'eligible');
            if (decision === 'unknown') unknown = true;
          }
          if (unknown) return forget(key, 'unknown');
          const fingerprint = policy + JSON.stringify(addresses);
          const previous = observations.get(key);
          if (!previous || previous.fingerprint !== fingerprint) {
            // Bound memory and fail conservatively if a very large registry exceeds capacity.
            if (observations.size >= 10_000) return forget(key, 'unknown');
            observations.set(key, { fingerprint, firstSeen: now() });
            return { status: 'observing' };
          }
          if (now() - previous.firstSeen < observationMs) return { status: 'observing' };
          await group.sync();
          if (!await group.isSuperAdmin(bot.inboxId) || await protectedMember(group, bot.inboxId, inboxId)) return forget(key, 'protected');
          const latestMember = (await group.members()).find(item => item.inboxId === inboxId);
          if (!latestMember) return forget(key, 'absent');
          if (JSON.stringify(addressesOf(latestMember)) !== JSON.stringify(addresses)) return forget(key, 'unknown');
          const latestRooms = await getRooms();
          if (JSON.stringify(latestRooms.find(item => item.id === roomId)) !== policy) return forget(key, 'unknown');
          if (mode === 'audit') return { status: 'would-remove' };
          await group.removeMembers([inboxId]);
          return forget(key, 'removed');
        });
      } catch { return forget(key, 'unknown'); }
    },
  };
}
