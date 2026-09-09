import { getAddress, recoverMessageAddress } from "viem";
import { checkRateLimit, logEvent } from "./server-utils.js";

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX = "chirpy:usersync:";
const MAX_BLOB = 400_000;

// MUST byte-match AUTH_MESSAGE in apps/web/src/userSync.ts.
// This write-authorization signature is distinct from the key-derivation signature.
const AUTH_MESSAGE =
  "Chirpy sync — authorize device writes (v1)\n\nSign to let this device save your encrypted sync blob. Gas-free; proves wallet ownership only.";

const isAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(String(s || ""));

async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`KV ${r.status}`);
  const result = await r.json();
  if (result.error) throw new Error("Storage command failed");
  return result;
}

async function readRec(addrLower) {
  if (!KV_URL || !KV_TOKEN) throw new Error("Sync storage is unavailable");
  const j = await kv(["GET", PREFIX + addrLower]);
  return j?.result ? JSON.parse(j.result) : null;
}

// Redis executes the revision check and replacement atomically. Legacy records
// have revision 0; legacy clients without an expected revision must refresh.
export const SYNC_CAS = `
local raw = redis.call('GET', KEYS[1])
local current = raw and cjson.decode(raw) or {}
local revision = tonumber(current.revision) or 0
if revision ~= tonumber(ARGV[1]) then return {0, revision} end
local next = cjson.decode(ARGV[2])
next.revision = revision + 1
redis.call('SET', KEYS[1], cjson.encode(next))
return {1, next.revision}
`;

export default async function handler(req, res) {
  const route = "/api/usersync";
  const startedAt = Date.now();
  const method = String(req?.method || "unknown");
  logEvent("request.started", { route, method });
  const respond = (status, body, outcome = status >= 500 ? "error" : "completed") => {
    logEvent("request.completed", {
      route,
      method,
      status,
      durationMs: Date.now() - startedAt,
      outcome,
    });
    return res.status(status).json(body);
  };

  try {
    const decision = checkRateLimit(req, route);
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfterSeconds));
      return respond(429, { error: "too many requests" }, "rate_limited");
    }

    if (req.method === "GET") {
      const address = String(req.query.address || "");
      if (!isAddr(address)) return respond(400, { error: "bad address" });
      const rec = await readRec(address.toLowerCase());
      return respond(200, rec ? { ...rec, revision: Number(rec.revision) || 0 } : { blob: null, updatedAt: 0, revision: 0 });
    }

    if (req.method === "POST") {
      if (!KV_URL || !KV_TOKEN) {
        return respond(503, { error: "sync storage not configured" });
      }

      const { address, signature, blob, expectedRevision } = req.body || {};
      if (!isAddr(address) || typeof signature !== "string" || typeof blob !== "string") {
        return respond(400, { error: "bad request" });
      }
      if (blob.length > MAX_BLOB) return respond(413, { error: "blob too large" });

      let signer;
      try {
        signer = await recoverMessageAddress({ message: AUTH_MESSAGE, signature });
      } catch {
        return respond(401, { error: "bad signature" });
      }
      if (getAddress(signer) !== getAddress(address)) {
        return respond(403, { error: "signature does not match address" });
      }

      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return respond(409, { stale: true, error: "Refresh sync state before saving." });
      }
      const result = await kv(["EVAL", SYNC_CAS, "1", PREFIX + address.toLowerCase(),
        String(expectedRevision), JSON.stringify({ blob, updatedAt: Date.now() })]);
      const [accepted, revision] = result.result || [];
      if (accepted === 0) return respond(409, { stale: true, revision });
      if (accepted !== 1) throw new Error("Invalid storage result");
      return respond(200, { ok: true, revision });
    }

    res.setHeader("Allow", "GET, POST");
    return respond(405, { error: "method not allowed" });
  } catch (e) {
    return respond(503, { error: "Sync storage is temporarily unavailable. Your local data is unchanged." });
  }
}
