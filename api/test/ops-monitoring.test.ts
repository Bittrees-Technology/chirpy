import { afterEach, describe, expect, it, vi } from "vitest";

import { buildGateHealthReport, buildHealthReport, normalizeWorkflowEvent } from "../ops-utils.js";
import roomJoinHandler from "../room-join.js";

function createRes() {
  return {
    body: undefined,
    headers: {},
    statusCode: 200,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function loggedEvents(spy) {
  return spy.mock.calls.map(([entry]) => JSON.parse(String(entry)).event);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildHealthReport", () => {
  it("marks XMTP releases degraded when gatekeeper and sync storage are missing", () => {
    const report = buildHealthReport({
      CHIRPY_BASE_URL: "https://staging.chirpy.example",
      CHIRPY_RELEASE_CHANNEL: "staging",
      VERCEL_ENV: "preview",
      VITE_GATEKEEPER_ADDRESS: "0x0000000000000000000000000000000000000001",
      VITE_MAINNET_RPC_URL: "https://rpc.example",
      VITE_TRANSPORT: "xmtp",
    });

    expect(report.status).toBe("degraded");
    expect(report.readiness.releaseReady).toBe(false);
    expect(report.checks.find((check) => check.name === "gatekeeper")?.status).toBe("degraded");
    expect(report.checks.find((check) => check.name === "usersync")?.status).toBe("degraded");
  });

  it("accepts an external gate topology on the web deployment", () => {
    const report = buildHealthReport({
      CHIRPY_BASE_URL: "https://chirpy.example",
      CHIRPY_EXTERNAL_GATE_URL: "https://gate.example.org/api/room-join",
      CHIRPY_RELEASE_CHANNEL: "staging",
      KV_REST_API_TOKEN: "token",
      KV_REST_API_URL: "https://kv.example",
      VERCEL_ENV: "production",
      VITE_GATEKEEPER_ADDRESS: "0x0000000000000000000000000000000000000001",
      VITE_MAINNET_RPC_URL: "https://rpc.example",
      VITE_TRANSPORT: "xmtp",
    });

    expect(report.status).toBe("ok");
    expect(report.runtime.gateMode).toBe("external");
    expect(report.runtime.externalGate).toBe("gate.example.org");
    expect(report.readiness.gateReady).toBe(true);
    expect(report.readiness.embeddedGateReady).toBe(false);
    expect(report.readiness.releaseReady).toBe(true);
    expect(report.checks.find((check) => check.name === "gate-route")?.status).toBe("ok");
    expect(report.checks.find((check) => check.name === "gatekeeper")?.status).toBe("info");
  });
});

describe("buildGateHealthReport", () => {
  it("returns an unready gate health report when the server RPC is missing", () => {
    const report = buildGateHealthReport({
      GATE_ALLOW_ORIGIN: "https://chirpy.example",
      XMTP_GATEKEEPER_PRIVATE_KEY: "0xabc",
    });

    expect(report.ok).toBe(false);
    expect(report.status).toBe("degraded");
    expect(report.checks.find((check) => check.name === "server-rpc")?.status).toBe("degraded");
    expect(report.blockingIssues).toContain("MAINNET_RPC_URL is not configured for the gate service.");
  });
});

describe("normalizeWorkflowEvent", () => {
  it("accepts allowlisted rollout evidence fields", () => {
    expect(
      normalizeWorkflowEvent({
        event: "rollout.healthcheck",
        channel: "staging",
        check: "health",
        deployment: "chirpy-staging.example",
        environment: "preview",
        releasePhase: "post-deploy",
        result: "ok",
        transport: "xmtp",
        version: "v0.1.2",
      }),
    ).toEqual({
      event: "rollout.healthcheck",
      channel: "staging",
      check: "health",
      deployment: "chirpy-staging.example",
      environment: "preview",
      releasePhase: "post-deploy",
      result: "ok",
      transport: "xmtp",
      version: "v0.1.2",
    });
  });

  it("rejects malformed event names", () => {
    expect(normalizeWorkflowEvent({ event: "bad event name" })).toBeNull();
  });
});

describe("roomJoinHandler logging", () => {
  it("emits lifecycle logs for direct serverless requests", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const previousKey = process.env.XMTP_GATEKEEPER_PRIVATE_KEY;
    delete process.env.XMTP_GATEKEEPER_PRIVATE_KEY;

    try {
      const res = createRes();
      await roomJoinHandler({ body: {}, method: "POST" }, res);

      expect(res.statusCode).toBe(503);
      expect(loggedEvents(info)).toEqual(["request.started", "request.completed"]);
    } finally {
      if (previousKey === undefined) delete process.env.XMTP_GATEKEEPER_PRIVATE_KEY;
      else process.env.XMTP_GATEKEEPER_PRIVATE_KEY = previousKey;
    }
  });

  it("skips duplicate lifecycle logs when wrapped by the self-host gate", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const previousKey = process.env.XMTP_GATEKEEPER_PRIVATE_KEY;
    delete process.env.XMTP_GATEKEEPER_PRIVATE_KEY;

    try {
      const res = createRes();
      await roomJoinHandler({ body: {}, lifecycleLogged: true, method: "POST" }, res);

      expect(res.statusCode).toBe(503);
      expect(loggedEvents(info)).toEqual([]);
    } finally {
      if (previousKey === undefined) delete process.env.XMTP_GATEKEEPER_PRIVATE_KEY;
      else process.env.XMTP_GATEKEEPER_PRIVATE_KEY = previousKey;
    }
  });
});
