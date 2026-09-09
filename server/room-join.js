import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { evalGate, validateProductionGate } from "../packages/core/src/gating.ts";
import { makeViemChainReader } from "../packages/core/src/viemChainReader.ts";
import { getAddress, recoverMessageAddress } from "viem";
import { getGatekeeperClient } from "./gate-client.js";
import { checkRateLimit, logEvent } from "./server-utils.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const TTL = 5 * 60_000;
export async function loadRooms(file = process.env.CHIRPY_GATE_ROOMS_FILE) {
  if (!file) throw new Error("Room registry is not configured");
  const rooms = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error("Invalid room registry");
  const ids = new Set();
  for (const room of rooms) {
    if (!room || !ID.test(room.id) || ids.has(room.id) ||
        typeof room.namespace !== "string" || !room.namespace || room.namespace.length > 128 || /[\r\n]/.test(room.namespace) ||
        typeof room.title !== "string" || !room.title || room.title.length > 200 ||
        room.chainId !== 1 || !validateProductionGate(room.gate)) throw new Error("Invalid room registry");
    ids.add(room.id);
  }
  return rooms;
}

export function joinMessage(challenge) {
  return `Chirpy room join (v2)\nService: ${challenge.service}\nRoom: ${challenge.convId}\nNamespace: ${challenge.namespace}\nWallet: ${challenge.address}\nInbox: ${challenge.inboxId}\nNonce: ${challenge.nonce}\nExpires: ${challenge.expiresAt}\nGas-free authorization for this room only.`;
}

// One process owns the gatekeeper's durable XMTP database. Challenges are deliberately
// ephemeral: a restart invalidates them. Never share that database across processes.
export function createJoinHandler({ getClient = getGatekeeperClient, getRooms = loadRooms,
  reader = () => makeViemChainReader(process.env.MAINNET_RPC_URL),
  service = () => process.env.GATE_PUBLIC_URL, now = Date.now } = {}) {
  const challenges = new Map();
  let queue = Promise.resolve();
  const serialized = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  return async function handler(req, res) {
    const route = "/api/room-join";
    if (!req.lifecycleLogged) logEvent("request.started", { route, method: req.method });
    const respond = (status, body) => {
      if (!req.lifecycleLogged) logEvent("request.completed", { route, method: req.method, status });
      res.setHeader("Cache-Control", "no-store");
      return res.status(status).json(body);
    };
    try {
      if (!req.rateLimitChecked) {
        const decision = checkRateLimit(req, route);
        if (!decision.allowed) { res.setHeader("Retry-After", String(decision.retryAfterSeconds)); return respond(429, { error: "too many requests" }); }
      }
      if (req.method !== "POST") { res.setHeader("Allow", "POST"); return respond(405, { error: "method not allowed" }); }
      const body = req.body || {};
      const rooms = await getRooms();
      if (body.action === "catalog") {
        return respond(200, { rooms: rooms.filter((r) => r.namespace === body.namespace).map(({ id, namespace, title, gate }) => ({ id, namespace, title, gate })) });
      }
      for (const [nonce, challenge] of challenges) if (challenge.expiresAt <= now()) challenges.delete(nonce);
      if (body.action === "challenge") {
        const room = rooms.find((r) => r.id === body.convId && r.namespace === body.namespace);
        if (!room || !ADDRESS.test(body.address || "") || !ID.test(body.inboxId || "")) return respond(400, { error: "invalid room or identity" });
        const origin = new URL(service());
        if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("Invalid public gate URL");
        if (challenges.size >= 2000) return respond(429, { error: "too many pending requests" });
        const challenge = { service: origin.origin + origin.pathname, convId: room.id, namespace: room.namespace,
          address: getAddress(body.address), inboxId: body.inboxId, nonce: randomBytes(32).toString("hex"), expiresAt: now() + TTL };
        challenges.set(challenge.nonce, challenge);
        return respond(200, { ...challenge, message: joinMessage(challenge) });
      }
      if (body.action !== "join") return respond(400, { error: "request a v2 join challenge first" });
      const challenge = challenges.get(body.nonce);
      if (!challenge) return respond(401, { error: "challenge expired or already used" });
      challenges.delete(body.nonce); // consume before any await, including signature verification
      let signer;
      try { signer = await recoverMessageAddress({ message: joinMessage(challenge), signature: body.signature }); }
      catch { return respond(401, { error: "invalid signature" }); }
      if (getAddress(signer) !== challenge.address) return respond(403, { error: "signature does not match wallet" });
      // Reloaded registry above is authoritative even if an operator changed it after challenge issuance.
      const room = rooms.find((r) => r.id === challenge.convId && r.namespace === challenge.namespace);
      if (!room || !validateProductionGate(room.gate)) return respond(403, { error: "room unavailable" });
      return await serialized(async () => {
        if (challenge.expiresAt <= now()) return respond(401, { error: "challenge expired" });
        const bot = await getClient();
        const { IdentifierKind } = await import("@xmtp/node-sdk");
        const actualInbox = await bot.fetchInboxIdByIdentifier({ identifier: challenge.address.toLowerCase(), identifierKind: IdentifierKind.Ethereum });
        if (actualInbox !== challenge.inboxId) return respond(403, { error: "inbox does not belong to wallet" });
        if (!await evalGate(room.gate, challenge.address, reader(), { roleCascade: {}, powerTier: null })) return respond(403, { error: "gate check failed" });
        await bot.conversations.sync();
        const conversation = await bot.conversations.getConversationById(room.id);
        if (!conversation || typeof conversation.addMembers !== "function") return respond(404, { error: "room not found" });
        await conversation.sync();
        if (typeof conversation.isSuperAdmin !== "function" || !await conversation.isSuperAdmin(bot.inboxId)) return respond(403, { error: "gatekeeper is not a room super-admin" });
        await conversation.addMembers([challenge.inboxId]);
        return respond(200, { ok: true });
      });
    } catch {
      return respond(503, { error: "Room access is temporarily unavailable. Ask an administrator to check the gate service." });
    }
  };
}
export default createJoinHandler();
