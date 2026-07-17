const DEFAULT_RELEASE_CHANNEL = "local";

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeTransport = (value) => (value === "xmtp" ? "xmtp" : "mock");

const firstNonEmpty = (...values) => values.find(nonEmpty) || null;

function pickDeploymentHost(value) {
  if (!nonEmpty(value)) return null;
  try {
    return new URL(value).host;
  } catch {
    return String(value).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

function normalizeGateState(env) {
  const privateKeyConfigured = nonEmpty(env.XMTP_GATEKEEPER_PRIVATE_KEY);
  const serverRpcConfigured = nonEmpty(env.MAINNET_RPC_URL);
  const externalUrl = firstNonEmpty(env.CHIRPY_EXTERNAL_GATE_URL);
  return {
    configured: privateKeyConfigured && serverRpcConfigured,
    externalConfigured: nonEmpty(externalUrl),
    externalUrl,
    mode: nonEmpty(externalUrl) ? "external" : "same-origin",
    privateKeyConfigured,
    serverRpcConfigured,
  };
}

function normalizeSyncState(env) {
  const kvConfigured =
    (nonEmpty(env.KV_REST_API_URL) && nonEmpty(env.KV_REST_API_TOKEN))
    || (nonEmpty(env.UPSTASH_REDIS_REST_URL) && nonEmpty(env.UPSTASH_REDIS_REST_TOKEN));
  return { configured: kvConfigured };
}

function healthCheck(name, status, summary, extra = {}) {
  return { name, status, summary, ...extra };
}

export function buildGateHealthReport(env = process.env) {
  const privateKeyConfigured = nonEmpty(env.XMTP_GATEKEEPER_PRIVATE_KEY);
  const serverRpcConfigured = nonEmpty(env.MAINNET_RPC_URL);
  const allowOrigin = firstNonEmpty(env.GATE_ALLOW_ORIGIN, "*");
  const warnings = [];
  const blockingIssues = [];
  const checks = [];

  if (privateKeyConfigured) {
    checks.push(healthCheck("gatekeeper-key", "ok", "Gatekeeper private key is configured."));
  } else {
    const summary = "XMTP_GATEKEEPER_PRIVATE_KEY is not configured.";
    checks.push(healthCheck("gatekeeper-key", "degraded", summary));
    blockingIssues.push(summary);
  }

  if (serverRpcConfigured) {
    checks.push(healthCheck("server-rpc", "ok", "Server mainnet RPC is configured for gate reads."));
  } else {
    const summary = "MAINNET_RPC_URL is not configured for the gate service.";
    checks.push(healthCheck("server-rpc", "degraded", summary));
    blockingIssues.push(summary);
  }

  if (allowOrigin === "*") {
    const summary = "GATE_ALLOW_ORIGIN is wildcard; lock it to the exact Chirpy origin in production.";
    checks.push(healthCheck("cors-origin", "info", summary));
    warnings.push(summary);
  } else {
    checks.push(healthCheck("cors-origin", "ok", "Gate CORS origin is pinned to an explicit Chirpy origin."));
  }

  return {
    ok: blockingIssues.length === 0,
    status: blockingIssues.length > 0 ? "degraded" : "ok",
    gatekeeper: privateKeyConfigured,
    serverRpcConfigured,
    allowOriginMode: allowOrigin === "*" ? "wildcard" : "exact",
    checks,
    warnings,
    blockingIssues,
  };
}

export function readRuntimeProfile(env = process.env) {
  const transport = normalizeTransport(env.VITE_TRANSPORT);
  const gate = normalizeGateState(env);
  const sync = normalizeSyncState(env);

  return {
    transport,
    channel: firstNonEmpty(env.CHIRPY_RELEASE_CHANNEL, env.VERCEL_ENV) || DEFAULT_RELEASE_CHANNEL,
    environment: firstNonEmpty(env.VERCEL_ENV, env.NODE_ENV) || "development",
    deployment: pickDeploymentHost(firstNonEmpty(env.CHIRPY_BASE_URL, env.VERCEL_URL)),
    gitSha: firstNonEmpty(env.VERCEL_GIT_COMMIT_SHA, env.GIT_COMMIT_SHA),
    browserRpcConfigured: nonEmpty(env.VITE_MAINNET_RPC_URL),
    walletConnectConfigured: nonEmpty(env.VITE_WALLETCONNECT_PROJECT_ID),
    gatekeeperAddressConfigured: nonEmpty(env.VITE_GATEKEEPER_ADDRESS),
    gate,
    sync,
  };
}

export function buildHealthReport(env = process.env) {
  const profile = readRuntimeProfile(env);
  const warnings = [];
  const blockingIssues = [];
  const checks = [];
  const externalGateHost = pickDeploymentHost(profile.gate.externalUrl);
  const gateRouteReady = profile.gate.externalConfigured || profile.gate.configured;

  checks.push(
    healthCheck(
      "transport",
      "ok",
      profile.transport === "xmtp"
        ? "XMTP transport selected for this build."
        : "Mock transport selected; wallet/server integrations are optional in this deployment.",
    ),
  );

  if (profile.browserRpcConfigured) {
    checks.push(healthCheck("browser-rpc", "ok", "Browser mainnet RPC is configured for ENS lookups."));
  } else {
    const summary = "Browser mainnet RPC is not configured; ENS name/avatar lookups will be unavailable.";
    checks.push(healthCheck("browser-rpc", profile.transport === "xmtp" ? "degraded" : "info", summary));
    if (profile.transport === "xmtp") warnings.push(summary);
  }

  if (profile.walletConnectConfigured) {
    checks.push(healthCheck("walletconnect", "ok", "WalletConnect is configured for mobile wallet flows."));
  } else {
    checks.push(
      healthCheck(
        "walletconnect",
        "info",
        "WalletConnect is not configured; injected wallets still work, but deep-link/mobile flows are limited.",
      ),
    );
  }

  if (profile.gate.externalConfigured) {
    checks.push(
      healthCheck(
        "gate-route",
        "ok",
        `Gated-room joins are routed to the external gate at ${externalGateHost}.`,
      ),
    );
    if (profile.gate.configured) {
      checks.push(
        healthCheck(
          "gatekeeper",
          "ok",
          "Embedded gatekeeper credentials are also configured on this deployment.",
        ),
      );
    } else {
      checks.push(
        healthCheck(
          "gatekeeper",
          "info",
          "This deployment relies on the external gate and does not host embedded gatekeeper credentials.",
        ),
      );
    }
  } else if (profile.gate.configured) {
    checks.push(
      healthCheck(
        "gate-route",
        "ok",
        "Gated-room joins use this deployment's own /api/room-join handler.",
      ),
    );
    checks.push(healthCheck("gatekeeper", "ok", "Gatekeeper credentials and server RPC are configured."));
  } else {
    const missing = [];
    if (!profile.gate.privateKeyConfigured) missing.push("XMTP_GATEKEEPER_PRIVATE_KEY");
    if (!profile.gate.serverRpcConfigured) missing.push("MAINNET_RPC_URL");
    const summary = `Same-origin gatekeeper is not fully configured; missing ${missing.join(" and ")}.`;
    checks.push(
      healthCheck(
        "gate-route",
        "degraded",
        "Gated-room joins fall back to this deployment's /api/room-join handler, but that handler is not fully configured.",
      ),
    );
    checks.push(healthCheck("gatekeeper", "degraded", summary));
    if (profile.transport === "xmtp") {
      blockingIssues.push(summary);
    } else {
      warnings.push(summary);
    }
  }

  if (profile.gatekeeperAddressConfigured) {
    checks.push(healthCheck("gatekeeper-address", "ok", "Browser gatekeeper address is configured for new gated rooms."));
  } else {
    const summary = "VITE_GATEKEEPER_ADDRESS is not configured; newly created gated rooms will not auto-add the gatekeeper bot.";
    checks.push(healthCheck("gatekeeper-address", "degraded", summary));
    if (profile.transport === "xmtp") warnings.push(summary);
  }

  if (profile.sync.configured) {
    checks.push(healthCheck("usersync", "ok", "Cross-device sync storage is configured."));
  } else {
    const summary = "Cross-device sync storage is not configured; /api/usersync writes will return 503.";
    checks.push(healthCheck("usersync", "degraded", summary));
    if (profile.transport === "xmtp") blockingIssues.push(summary);
    else warnings.push(summary);
  }

  const releaseReady =
    profile.transport !== "xmtp" || (
      profile.browserRpcConfigured
      && gateRouteReady
      && profile.gatekeeperAddressConfigured
      && profile.sync.configured
    );

  const status = blockingIssues.length > 0 ? "degraded" : "ok";

  return {
    ok: true,
    status,
    runtime: {
      transport: profile.transport,
      channel: profile.channel,
      environment: profile.environment,
      deployment: profile.deployment,
      gitSha: profile.gitSha,
      gateMode: profile.gate.mode,
      externalGate: externalGateHost,
    },
    readiness: {
      previewReady: true,
      gateReady: gateRouteReady,
      embeddedGateReady: profile.gate.configured,
      syncReady: profile.sync.configured,
      releaseReady,
    },
    checks,
    warnings,
    blockingIssues,
  };
}

export function normalizeWorkflowEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const event = nonEmpty(input.event) ? String(input.event).trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(event)) return null;

  const normalized = { event };
  const fields = [
    "channel",
    "version",
    "transport",
    "releasePhase",
    "result",
    "environment",
    "deployment",
    "check",
  ];
  for (const field of fields) {
    if (nonEmpty(input[field])) normalized[field] = String(input[field]).trim();
  }
  return normalized;
}
