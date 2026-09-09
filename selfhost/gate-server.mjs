import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { buildGateHealthReport } from "../server/ops-utils.js";
import roomJoinHandler, { loadRooms } from "../server/room-join.js";
import { checkRateLimit, logEvent } from "../server/server-utils.js";

const MAX_BODY_BYTES = 32_768;
const REQUEST_TIMEOUT_MS = 10_000;

export function createGateServer({ handler = roomJoinHandler, registry = loadRooms, env = process.env } = {}) {
  const allowedOrigin = env.GATE_ALLOW_ORIGIN || "";
  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    let route = "invalid";
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Vary", "Origin");
    res.once("finish", () => logEvent("request.completed", { route, method: req.method,
      status: res.statusCode, durationMs: Date.now() - startedAt }));
    const respond = (status, body) => {
      if (res.writableEnded || res.destroyed) return;
      res.statusCode = status;
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      route = new URL(req.url, "http://localhost").pathname;
      if (!["/health", "/", "/api/room-join"].includes(route)) {
        route = "unknown"; return respond(404, { error: "not found" });
      }
      const origin = req.headers.origin;
      if (origin && (allowedOrigin === "*" || !allowedOrigin || origin !== allowedOrigin)) return respond(403, { error: "origin not allowed" });
      if (origin) res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      if (route === "/health" || route === "/") {
        if (!["GET", "HEAD"].includes(req.method)) { res.setHeader("Allow", "GET, HEAD"); return respond(405, { error: "method not allowed" }); }
        const report = buildGateHealthReport(env);
        try { await registry(); }
        catch { report.ok = false; report.status = "degraded"; report.blockingIssues.push("Room registry cannot be loaded or validated."); }
        return respond(report.ok ? 200 : 503, req.method === "HEAD" ? undefined : report);
      }
      if (req.method === "OPTIONS") {
        const headers = String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
        if (!origin || req.headers["access-control-request-method"] !== "POST" || headers.some((h) => h !== "content-type")) return respond(400, { error: "invalid preflight" });
        res.setHeader("Access-Control-Allow-Methods", "POST");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        return respond(204);
      }
      if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return respond(405, { error: "method not allowed" }); }
      const rate = checkRateLimit(req, route);
      if (!rate.allowed) { res.setHeader("Retry-After", String(rate.retryAfterSeconds)); return respond(429, { error: "too many requests" }); }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return respond(415, { error: "application/json required" });
      if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") return respond(415, { error: "compressed requests are not supported" });
      const length = Number(req.headers["content-length"]);
      if (length > MAX_BODY_BYTES) { res.setHeader("Connection", "close"); return respond(413, { error: "request too large" }); }
      const chunks = [];
      let bytes = 0;
      const timer = setTimeout(() => { respond(408, { error: "request timed out" }); req.destroy(); }, REQUEST_TIMEOUT_MS);
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            res.setHeader("Connection", "close"); respond(413, { error: "request too large" }); return;
          }
          chunks.push(chunk);
        }
      } finally { clearTimeout(timer); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return respond(400, { error: "bad json" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return respond(400, { error: "JSON object required" });
      let status = 200;
      await handler({ method: "POST", body, rateLimitChecked: true, lifecycleLogged: true }, {
        setHeader: (key, value) => res.setHeader(key, value),
        status(code) { status = code; return this; },
        json(payload) { respond(status, payload); return this; },
      });
    } catch {
      respond(503, { error: "Gate service temporarily unavailable" });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.GATE_PORT || 8788);
  createGateServer().listen(port, () => logEvent("server.started", { route: "selfhost/gate-server", port }));
}
