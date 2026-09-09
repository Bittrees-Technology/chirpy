import { recoverMessageAddress, keccak256, stringToHex } from "viem";
import { SYNC_AUTH_MAX_AGE, syncGrantMessage, syncWriteMessage, syncRevokeDeviceMessage, syncRevokeAllMessage } from "../packages/core/src/syncAuth.js";
import { checkRateLimit, logEvent } from "./server-utils.js";

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX = "chirpy:usersync:";
const MAX_BLOB = 400_000;
const SERVICE = process.env.CHIRPY_SYNC_SERVICE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/usersync` : "");
const isAddr = (s) => typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
const validSignature = (s) => typeof s === "string" && /^0x[a-fA-F0-9]{130}$/.test(s);
const epochKey = (address) => `${PREFIX}epoch:${address}`;
const revokedKey = (grant) => `${PREFIX}revoked:${grant.address.toLowerCase()}:${keccak256(stringToHex(syncGrantMessage(grant)))}`;
const same = (left, right) => left.toLowerCase() === right.toLowerCase();
async function kv(cmd) {
  if (!KV_URL || !KV_TOKEN) throw new Error("Sync storage is unavailable");
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error("Sync storage is unavailable");
  const result = await r.json();
  if (result.error) throw new Error("Storage command failed");
  return result.result;
}

// Authorization and data revision are checked in the same Redis transaction.
export const SYNC_CAS = `
local epoch = tonumber(redis.call('GET', KEYS[2]) or '0')
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if now >= tonumber(ARGV[4]) then return {-2, epoch} end
if epoch ~= tonumber(ARGV[3]) or redis.call('EXISTS', KEYS[3]) == 1 then return {-1, epoch} end
local raw = redis.call('GET', KEYS[1])
local current = raw and cjson.decode(raw) or {}
local revision = tonumber(current.revision) or 0
if revision ~= tonumber(ARGV[1]) then return {0, revision} end
local next = cjson.decode(ARGV[2])
next.revision = revision + 1
redis.call('SET', KEYS[1], cjson.encode(next))
return {1, next.revision}
`;
export const SYNC_REVOKE_ALL = `
local epoch = tonumber(redis.call('GET', KEYS[1]) or '0')
if epoch ~= tonumber(ARGV[1]) then return {0, epoch} end
redis.call('SET', KEYS[1], tostring(epoch + 1))
return {1, epoch + 1}
`;
export const SYNC_REVOKE_DEVICE = `
local epoch = tonumber(redis.call('GET', KEYS[1]) or '0')
if epoch ~= tonumber(ARGV[1]) then return {0, epoch} end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[2])
return {1, epoch}
`;
function validGrant(grant, address, now) {
  return grant?.version === 2 && grant.service === SERVICE && isAddr(grant.address) && same(grant.address, address) && isAddr(grant.device) &&
    Number.isSafeInteger(grant.epoch) && grant.epoch >= 0 && grant.epoch < Number.MAX_SAFE_INTEGER &&
    Number.isSafeInteger(grant.issuedAt) && Number.isSafeInteger(grant.expiresAt) && grant.issuedAt <= now + 30_000 &&
    grant.expiresAt > now && grant.expiresAt > grant.issuedAt && grant.expiresAt - grant.issuedAt <= SYNC_AUTH_MAX_AGE;
}
async function signedBy(message, signature, address) {
  if (!validSignature(signature)) return false;
  try { return same(await recoverMessageAddress({ message, signature }), address); } catch { return false; }
}
export default async function handler(req, res) {
  const route = "/api/usersync";
  const startedAt = Date.now();
  const method = String(req?.method || "unknown");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const respond = (status, body) => {
    logEvent("request.completed", { route, method, status, durationMs: Date.now() - startedAt, outcome: status >= 500 ? "error" : "completed" });
    return res.status(status).json(body);
  };
  try {
    const decision = checkRateLimit(req, route);
    if (!decision.allowed) { res.setHeader("Retry-After", String(decision.retryAfterSeconds)); return respond(429, { error: "too many requests" }); }
    if (method !== "GET" && method !== "POST") { res.setHeader("Allow", "GET, POST"); return respond(405, { error: "method not allowed" }); }
    if (!SERVICE || !/^https:\/\//.test(SERVICE)) return respond(503, { error: "Sync service identity is not configured." });
    if (method === "GET") {
      const address = String(req.query?.address || "");
      if (!isAddr(address)) return respond(400, { error: "bad address" });
      const [raw, rawEpoch] = await kv(["MGET", PREFIX + address.toLowerCase(), epochKey(address.toLowerCase())]);
      const record = raw ? JSON.parse(raw) : { blob: null, updatedAt: 0, revision: 0 };
      return respond(200, { ...record, revision: Number(record.revision) || 0, epoch: Number(rawEpoch) || 0, authVersion: 2, service: SERVICE });
    }
    if (String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") return respond(415, { error: "Use application/json." });
    const { action, address, authorization, signature, blob, expectedRevision, epoch, expiresAt } = req.body || {};
    if (!isAddr(address)) return respond(400, { error: "bad address" });
    const now = Date.now();
    if (action === "revoke-all") {
      if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 300_000) return respond(400, { error: "Invalid revocation scope." });
      if (!await signedBy(syncRevokeAllMessage(SERVICE, address, epoch, expiresAt), signature, address)) return respond(401, { error: "Invalid revocation signature." });
      const [ok, nextEpoch] = await kv(["EVAL", SYNC_REVOKE_ALL, "1", epochKey(address.toLowerCase()), String(epoch)]);
      return ok === 1 ? respond(200, { ok: true, epoch: nextEpoch }) : respond(409, { error: "Authorization changed. Retry revocation." });
    }
    if (action !== "write" && action !== "revoke-device") return respond(401, { error: "Refresh Chirpy and enable sync to use device authorization v2." });
    if (!validGrant(authorization, address, now) || !await signedBy(syncGrantMessage(authorization), authorization.signature, address)) return respond(401, { error: "Invalid or expired device authorization. Re-enable sync." });
    if (action === "revoke-device") {
      if (!await signedBy(syncRevokeDeviceMessage(authorization), signature, authorization.device)) return respond(401, { error: "Invalid device signature." });
      const [ok] = await kv(["EVAL", SYNC_REVOKE_DEVICE, "2", epochKey(address.toLowerCase()), revokedKey(authorization), String(authorization.epoch), String(authorization.expiresAt - now)]);
      if (ok !== 0 && ok !== 1) throw new Error("Invalid revocation result");
      return respond(200, { ok: true, alreadyRevoked: ok === 0 });
    }
    if (typeof blob !== "string") return respond(400, { error: "bad encrypted blob" });
    if (Buffer.byteLength(blob, "utf8") > MAX_BLOB) return respond(413, { error: "blob too large" });
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) return respond(409, { stale: true, error: "Refresh sync state before saving." });
    if (!await signedBy(syncWriteMessage(authorization, expectedRevision, keccak256(stringToHex(blob))), signature, authorization.device)) return respond(401, { error: "Invalid device write signature." });
    const [accepted, revision] = await kv(["EVAL", SYNC_CAS, "3", PREFIX + address.toLowerCase(), epochKey(address.toLowerCase()), revokedKey(authorization), String(expectedRevision), JSON.stringify({ blob, updatedAt: now }), String(authorization.epoch), String(authorization.expiresAt)]);
    if (accepted === -2) return respond(401, { error: "Device authorization expired. Re-enable sync." });
    if (accepted === -1) return respond(403, { error: "Device authorization was revoked. Re-enable sync." });
    if (accepted === 0) return respond(409, { stale: true, revision });
    if (accepted !== 1) throw new Error("Invalid storage result");
    return respond(200, { ok: true, revision });
  } catch { return respond(503, { error: "Sync storage is temporarily unavailable. Your local data is unchanged." }); }
}
