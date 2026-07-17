import { buildHealthReport } from "./ops-utils.js";
import { checkRateLimit, logEvent } from "./server-utils.js";

export default async function handler(req, res) {
  const route = "/api/health";
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

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return respond(405, { error: "method not allowed" });
    }

    return respond(200, buildHealthReport(process.env));
  } catch (error) {
    return respond(500, { error: String(error?.message || error) });
  }
}
