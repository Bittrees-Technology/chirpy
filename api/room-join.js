import { checkRateLimit, logEvent } from "../server/server-utils.js";

// XMTP membership changes require the durable, single-process self-hosted gate.
// This endpoint deliberately has no dependency on the native SDK or TS sources.
export default function handler(req, res) {
  const route = "/api/room-join";
  logEvent("request.started", { route, method: req.method });
  res.setHeader("Cache-Control", "no-store");
  const limit = checkRateLimit(req, route);
  let status = 503;
  let error = "Room access requires a configured external gate service. Ask an administrator to configure the room's gate URL.";
  if (!limit.allowed) {
    status = 429; error = "too many requests";
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
  } else if (req.method !== "POST") {
    status = 405; error = "method not allowed";
    res.setHeader("Allow", "POST");
  }
  logEvent("request.completed", { route, method: req.method, status });
  return res.status(status).json({ error });
}
