// Self-hosted Chirpy gate.
//
// Wraps the SAME room-join handler the Vercel deployment uses (`api/room-join.js`) in a
// long-running Node HTTP server. The gate runs the XMTP gatekeeper bot, which needs a
// runtime that supports @xmtp/node-sdk's native bindings — Vercel's serverless runtime
// does not, so self-hosting (or any always-on container/VM) is the way to run it.
//
// Serves `POST /api/room-join` with CORS. Point an org's `OrgConfig.gateUrl` here, e.g.
// https://gate.acme.org/api/room-join. Required env: XMTP_GATEKEEPER_PRIVATE_KEY,
// MAINNET_RPC_URL. Optional: GATE_PORT (default 8788), GATE_ALLOW_ORIGIN (default *).
import { createServer } from "node:http";
import roomJoinHandler from "../api/room-join.js";

const PORT = Number(process.env.GATE_PORT || 8788);
const ALLOW_ORIGIN = process.env.GATE_ALLOW_ORIGIN || "*";

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Vary", "Origin");
}

// Adapt a Node ServerResponse to the { setHeader, status().json() } shape the Vercel-style
// handler in api/room-join.js expects, so the gate logic stays in one place.
function vercelRes(nodeRes) {
  let code = 200;
  return {
    setHeader: (k, v) => nodeRes.setHeader(k, v),
    status(n) { code = n; return this; },
    json(obj) {
      nodeRes.statusCode = code;
      nodeRes.setHeader("content-type", "application/json");
      nodeRes.end(JSON.stringify(obj));
      return this;
    },
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  applyCors(res);
  const { pathname, searchParams } = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  if (pathname === "/health" || pathname === "/") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: true, gatekeeper: Boolean(process.env.XMTP_GATEKEEPER_PRIVATE_KEY) }));
  }

  if (pathname !== "/api/room-join") {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "not found" }));
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "bad json" }));
  }

  try {
    await roomJoinHandler(
      { method: req.method, body, query: Object.fromEntries(searchParams) },
      vercelRes(res),
    );
  } catch (e) {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  }
});

server.listen(PORT, () => {
  const keyed = process.env.XMTP_GATEKEEPER_PRIVATE_KEY ? "configured" : "NOT configured";
  console.log(`Chirpy gate listening on :${PORT} (gatekeeper ${keyed})`);
});
