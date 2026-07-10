import { decodeGate, evalGate } from "../packages/core/src/gating.ts";
import { makeViemChainReader } from "../packages/core/src/viemChainReader.ts";
import { getAddress, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkRateLimit, logEvent } from "./server-utils.js";

const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const JOIN_MESSAGE =
  "Chirpy room join — authorize gated room request (v1)\n\nSign to ask the gatekeeper to add your XMTP inbox to a gated room. Gas-free; proves wallet ownership only.";

const textEncoder = new TextEncoder();

const isAddr = (s) => ETH_ADDRESS.test(String(s || ""));
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hexToBytes = (hex) => {
  const clean = String(hex || "").replace(/^0x/, "");
  if (!clean || clean.length % 2 !== 0 || /[^a-fA-F0-9]/.test(clean)) {
    throw new Error("bad hex");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

function makeGatekeeperSigner(privateKey, identifierKind) {
  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const identifier = {
    identifier: account.address.toLowerCase(),
    identifierKind,
  };
  return {
    type: "EOA",
    getIdentifier: () => identifier,
    getChainId: () => 1n,
    signMessage: async (message) => hexToBytes(await account.signMessage({ message })),
  };
}

function clientOptions(logLevel) {
  return {
    env: "production",
    loggingLevel: logLevel,
    dbPath: (inboxId) => `/tmp/chirpy-xmtp-gatekeeper-${inboxId}.db3`,
  };
}

async function getGatekeeperClient() {
  const privateKey = process.env.XMTP_GATEKEEPER_PRIVATE_KEY;
  if (!privateKey) return null;
  const { Client, IdentifierKind, LogLevel } = await import("@xmtp/node-sdk");
  const client = await Client.create(
    makeGatekeeperSigner(privateKey, IdentifierKind.Ethereum),
    clientOptions(LogLevel.Off),
  );
  if (!client.isRegistered) await client.register();
  return client;
}

export default async function handler(req, res) {
  const route = "/api/room-join";
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
    if (!req?.rateLimitChecked) {
      const decision = checkRateLimit(req, route);
      if (!decision.allowed) {
        res.setHeader("Retry-After", String(decision.retryAfterSeconds));
        return respond(429, { error: "too many requests" }, "rate_limited");
      }
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return respond(405, { error: "method not allowed" });
    }

    const bot = await getGatekeeperClient();
    if (!bot) {
      return respond(503, { error: "gatekeeper is not configured" });
    }

    const { convId, address, signature, inboxId, gate, gating } = req.body || {};
    if (
      typeof convId !== "string" ||
      !isAddr(address) ||
      typeof signature !== "string" ||
      typeof inboxId !== "string" ||
      typeof gate !== "string"
    ) {
      return respond(400, { error: "bad request" });
    }

    let signer;
    try {
      signer = await recoverMessageAddress({ message: JOIN_MESSAGE, signature });
    } catch {
      return respond(401, { error: "bad signature" });
    }
    if (getAddress(signer) !== getAddress(address)) {
      return respond(403, { error: "signature does not match address" });
    }

    const decodedGate = decodeGate(gate);
    if ((decodedGate.rules?.length ?? 0) === 0) {
      return respond(400, { error: "room is open" });
    }
    const gatingConfig = isObject(gating) ? gating : {};

    const passes = await evalGate(
      decodedGate,
      getAddress(address),
      makeViemChainReader(process.env.MAINNET_RPC_URL),
      {
        roleCascade: isObject(gatingConfig.roleCascade) ? gatingConfig.roleCascade : {},
        powerTier: isObject(gatingConfig.powerTier) ? gatingConfig.powerTier : undefined,
      },
    );
    if (!passes) return respond(403, { error: "gate check failed" });

    await bot.conversations.sync();
    await bot.conversations.syncAll();
    const conversation = await bot.conversations.getConversationById(convId);
    if (!conversation || typeof conversation.addMembers !== "function") {
      return respond(404, { error: "room not found" });
    }
    if (typeof conversation.isSuperAdmin === "function" && !conversation.isSuperAdmin(bot.inboxId)) {
      return respond(403, { error: "gatekeeper is not a room super-admin" });
    }

    await conversation.addMembers([inboxId]);
    return respond(200, { ok: true });
  } catch (e) {
    return respond(500, { error: String(e?.message || e) });
  }
}

export { JOIN_MESSAGE };
