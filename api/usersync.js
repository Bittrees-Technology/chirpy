import { getAddress, recoverMessageAddress } from "viem";

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
  return r.json();
}

async function readRec(addrLower) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const j = await kv(["GET", PREFIX + addrLower]);
    return j?.result ? JSON.parse(j.result) : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const address = String(req.query.address || "");
      if (!isAddr(address)) return res.status(400).json({ error: "bad address" });
      const rec = await readRec(address.toLowerCase());
      return res.status(200).json(rec || { blob: null, updatedAt: 0 });
    }

    if (req.method === "POST") {
      if (!KV_URL || !KV_TOKEN) {
        return res.status(503).json({ error: "sync storage not configured" });
      }

      const { address, signature, blob, updatedAt } = req.body || {};
      if (!isAddr(address) || typeof signature !== "string" || typeof blob !== "string") {
        return res.status(400).json({ error: "bad request" });
      }
      if (blob.length > MAX_BLOB) return res.status(413).json({ error: "blob too large" });

      let signer;
      try {
        signer = await recoverMessageAddress({ message: AUTH_MESSAGE, signature });
      } catch {
        return res.status(401).json({ error: "bad signature" });
      }
      if (getAddress(signer) !== getAddress(address)) {
        return res.status(403).json({ error: "signature does not match address" });
      }

      const incoming = Number(updatedAt) || Date.now();
      const cur = await readRec(address.toLowerCase());
      if (cur && Number(cur.updatedAt) > incoming) {
        return res.status(409).json({ stale: true, updatedAt: cur.updatedAt });
      }

      await kv(["SET", PREFIX + address.toLowerCase(), JSON.stringify({ blob, updatedAt: incoming })]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
