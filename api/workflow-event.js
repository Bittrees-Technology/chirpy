import { normalizeWorkflowEvent } from "./ops-utils.js";
import { checkRateLimit, logEvent } from "./server-utils.js";

export default async function handler(req, res) {
  const route = "/api/workflow-event";
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

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return respond(405, { error: "method not allowed" });
    }

    const payload = normalizeWorkflowEvent(req.body);
    if (!payload) return respond(400, { error: "bad workflow event" });

    logEvent("workflow.event", {
      route,
      method,
      status: 202,
      workflowEvent: payload.event,
      channel: payload.channel,
      version: payload.version,
      transport: payload.transport,
      releasePhase: payload.releasePhase,
      result: payload.result,
      environment: payload.environment,
      deployment: payload.deployment,
      check: payload.check,
    });

    return respond(202, { ok: true });
  } catch (error) {
    return respond(500, { error: String(error?.message || error) });
  }
}
