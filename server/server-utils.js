import { isIP } from "node:net";
const DEFAULT_RATE_LIMIT_MAX = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_KEYS = 10_000;

const bucketsByRoute = new Map();

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getRateLimitConfig() {
  return {
    max: positiveInt(process.env.CHIRPY_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
    windowMs: positiveInt(
      process.env.CHIRPY_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMIT_WINDOW_MS,
    ),
  };
}

function getClientKey(req) {
  const peer = String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip || "unknown");
  // Only an explicitly trusted, directly connected proxy may provide client IPs.
  // Use its last appended hop, never an attacker-controlled leftmost prefix.
  const trusted = String(process.env.CHIRPY_TRUSTED_PROXIES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (trusted.includes(peer)) {
    const hops = String(req?.headers?.["x-forwarded-for"] || "").split(",");
    const client = hops.at(-1)?.trim();
    if (client && isIP(client)) return client;
  }
  return peer;
}

function pruneExpired(now, windowMs) {
  for (const [route, buckets] of bucketsByRoute) {
    for (const [key, bucket] of buckets) {
      if (now - bucket.startedAt >= windowMs) buckets.delete(key);
    }
    if (buckets.size === 0) bucketsByRoute.delete(route);
  }
}

/**
 * Check and consume one request for a route/client pair.
 *
 * This intentionally stays process-local: it covers the self-host process and
 * each serverless instance without adding a new storage dependency. Deployments
 * that need a fleet-wide limit can replace this with a shared implementation.
 */
export function checkRateLimit(req, route) {
  const now = Date.now();
  const { max, windowMs } = getRateLimitConfig();
  pruneExpired(now, windowMs);

  let buckets = bucketsByRoute.get(route);
  if (!buckets) {
    buckets = new Map();
    bucketsByRoute.set(route, buckets);
  }

  const key = getClientKey(req);
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    if (!bucket && buckets.size >= MAX_RATE_LIMIT_KEYS) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
    }
    bucket = { startedAt: now, count: 0 };
    buckets.set(key, bucket);
  }

  bucket.count += 1;

  const retryAfterMs = Math.max(0, bucket.startedAt + windowMs - now);
  return {
    allowed: bucket.count <= max,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

/**
 * Emit JSON logs containing operational metadata only. Keep the allowlist here
 * so callers cannot accidentally add request data or exception contents.
 */
export function logEvent(event, fields = {}) {
  const allowedFields = [
    "route",
    "method",
    "status",
    "durationMs",
    "outcome",
    "port",
    "gatekeeperConfigured",
    "channel",
    "transport",
    "version",
    "workflowEvent",
    "releasePhase",
    "result",
    "environment",
    "deployment",
    "check",
    "mode",
    "checked",
    "removed",
    "wouldRemove",
    "unknown",
  ];
  const safeFields = {};
  for (const field of allowedFields) {
    if (fields[field] !== undefined) safeFields[field] = fields[field];
  }

  try {
    console.info(JSON.stringify({
      service: "chirpy",
      event,
      time: new Date().toISOString(),
      ...safeFields,
    }));
  } catch {
    // Logging must never alter the request's response behavior.
  }
}

export function writeRateLimitResponse(res, decision) {
  res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  const body = { error: "too many requests" };
  if (typeof res.status === "function") return res.status(429).json(body);

  res.statusCode = 429;
  res.setHeader("content-type", "application/json");
  return res.end(JSON.stringify(body));
}

// Useful for isolated tests and local development; production code never calls this.
export function resetRateLimits() {
  bucketsByRoute.clear();
}
