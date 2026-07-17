import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import healthHandler from "../api/health.js";
import workflowEventHandler from "../api/workflow-event.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_GATE_PORT = 8799;
const SAMPLE_GATEKEEPER_ADDRESS = "0x0000000000000000000000000000000000000001";
const SAMPLE_GATEKEEPER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

function createResponse() {
  return {
    body: undefined,
    headers: {},
    statusCode: 200,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
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

async function invoke(handler, req) {
  const res = createResponse();
  await handler(req, res);
  return res;
}

async function waitForGate(url, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.ok) return { response, body };
    } catch {
      // Ignore startup races and retry.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for gate health at ${url}`);
}

async function main() {
  const previousEnv = { ...process.env };
  const summary = {
    ok: false,
    commands: [
      "pnpm rollout:proof",
      "curl http://127.0.0.1:8799/health",
    ],
    checks: [],
  };

  try {
    Object.assign(process.env, {
      CHIRPY_BASE_URL: "https://chirpy.example.org",
      CHIRPY_EXTERNAL_GATE_URL: "https://gate.example.org/api/room-join",
      CHIRPY_RELEASE_CHANNEL: "staging",
      KV_REST_API_TOKEN: "token",
      KV_REST_API_URL: "https://kv.example",
      VERCEL_ENV: "preview",
      VITE_GATEKEEPER_ADDRESS: SAMPLE_GATEKEEPER_ADDRESS,
      VITE_MAINNET_RPC_URL: "https://rpc.example",
      VITE_TRANSPORT: "xmtp",
    });

    const health = await invoke(healthHandler, { headers: {}, method: "GET" });
    assert.equal(health.statusCode, 200, "Expected /api/health handler to return 200");
    assert.equal(health.body?.readiness?.releaseReady, true, "Expected releaseReady=true");
    summary.checks.push({
      name: "web-health",
      readiness: health.body.readiness,
      runtime: health.body.runtime,
      status: health.body.status,
    });

    const workflowEvent = await invoke(workflowEventHandler, {
      body: {
        check: "health",
        deployment: "chirpy.example.org",
        environment: "preview",
        event: "release.verify",
        releasePhase: "local-proof",
        result: "ok",
      },
      headers: {},
      method: "POST",
    });
    assert.equal(workflowEvent.statusCode, 202, "Expected /api/workflow-event handler to accept release telemetry");
    summary.checks.push({
      name: "workflow-event",
      status: workflowEvent.statusCode,
    });

    const gateProcess = spawn("node", ["selfhost/gate-server.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GATE_ALLOW_ORIGIN: "https://chirpy.example.org",
        GATE_PORT: String(LOCAL_GATE_PORT),
        MAINNET_RPC_URL: "https://rpc.example",
        XMTP_GATEKEEPER_PRIVATE_KEY: SAMPLE_GATEKEEPER_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    gateProcess.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    try {
      const gate = await waitForGate(`http://127.0.0.1:${LOCAL_GATE_PORT}/health`);
      assert.equal(gate.body?.ok, true, "Expected the local gate /health endpoint to report ready");
      summary.checks.push({
        name: "gate-health",
        body: gate.body,
        status: gate.response.status,
      });
    } finally {
      gateProcess.kill("SIGTERM");
      const [, signal] = await once(gateProcess, "exit");
      if (signal && signal !== "SIGTERM") {
        throw new Error(`Gate process exited unexpectedly with signal ${signal}: ${stderr}`);
      }
    }

    summary.ok = true;
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
