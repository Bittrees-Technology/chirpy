import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToHex } from "viem";
import { syncGrantMessage, syncWriteMessage, syncRevokeAllMessage, syncRevokeDeviceMessage } from "../../packages/core/src/syncAuth";
const container = process.env.CHIRPY_TEST_REDIS_CONTAINER;
const exec = promisify(execFile);
const service = "https://chirpy.test/api/usersync";
// A dedicated ephemeral Redis container is supplied locally or by the CI service.
describe.skipIf(!container)("real Redis sync transactions", () => {
  let server; let handler; let writeDelay = 0;
  const ownedKeys = new Set<string>();
  async function redis(args: string[]) {
    const { stdout } = await exec("docker", ["exec", container!, "redis-cli", "--json", ...args], { maxBuffer: 2_000_000 });
    return JSON.parse(stdout);
  }
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      try {
        let body = ""; for await (const chunk of req) body += chunk;
        const command = JSON.parse(body) as string[];
        if (command[0] === "EVAL") for (const key of command.slice(3, 3 + Number(command[2]))) ownedKeys.add(key);
        if (writeDelay && command[0] === "EVAL" && Number(command[2]) === 3) await new Promise((resolve) => setTimeout(resolve, writeDelay));
        const result = await redis(command);
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result }));
      } catch { res.statusCode = 503; res.end('{}'); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("KV_REST_API_URL", `http://127.0.0.1:${server.address().port}`);
    vi.stubEnv("KV_REST_API_TOKEN", "synthetic-test"); vi.stubEnv("CHIRPY_SYNC_SERVICE_URL", service);
    vi.resetModules(); handler = (await import("../../api/usersync.js")).default;
  });
  afterAll(async () => {
    if (ownedKeys.size) await redis(["DEL", ...ownedKeys]);
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(resolve));
    vi.unstubAllEnvs();
  });
  async function call(body: any, method = "POST") {
    const response = { code: 0, body: null as any, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, headers: { "content-type": "application/json" }, query: { address: body.address }, body }, response);
    return response;
  }
  async function session() {
    const wallet = privateKeyToAccount(generatePrivateKey()); const device = privateKeyToAccount(generatePrivateKey());
    const grant = { version: 2 as const, service, address: wallet.address, device: device.address, epoch: 0, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const authorization = { ...grant, signature: await wallet.signMessage({ message: syncGrantMessage(grant) }) };
    const write = async (blob: string, expectedRevision = 0) => ({ action: "write", address: wallet.address, authorization, blob, expectedRevision, signature: await device.signMessage({ message: syncWriteMessage(grant, expectedRevision, keccak256(stringToHex(blob))) }) });
    return { wallet, device, grant, authorization, write };
  }
  it("executes CAS and revoke-all atomically under concurrent signed requests", async () => {
    const sessionA = await session();
    const a = await sessionA.write("first"); const b = await sessionA.write("second");
    const results = await Promise.all([call(a), call(b)]);
    expect(results.map((result) => result.code).sort()).toEqual([200, 409]);
    const expiresAt = Date.now() + 60_000;
    const revoke = { action: "revoke-all", address: sessionA.wallet.address, epoch: 0, expiresAt, signature: await sessionA.wallet.signMessage({ message: syncRevokeAllMessage(service, sessionA.wallet.address, 0, expiresAt) }) };
    const delayed = await sessionA.write("racing", 1);
    const race = await Promise.all([call(delayed), call(revoke)]);
    expect([200, 403]).toContain(race[0].code); expect(race[1].code).toBe(200);
    const latest = await call({ address: sessionA.wallet.address }, "GET");
    expect(latest.body.epoch).toBe(1);
    expect((await call(await sessionA.write("after-revocation", latest.body.revision))).code).toBe(403);
    expect((await call(revoke)).code).toBe(409);
  });
  it("rejects a grant that expires while its write is waiting for storage", async () => {
    const sessionA = await session();
    sessionA.authorization.expiresAt = Date.now() + 500;
    sessionA.grant.expiresAt = sessionA.authorization.expiresAt;
    sessionA.authorization.signature = await sessionA.wallet.signMessage({ message: syncGrantMessage(sessionA.grant) });
    writeDelay = 750;
    try { expect((await call(await sessionA.write("expired-in-transit"))).code).toBe(401); }
    finally { writeDelay = 0; }
  });
  it("stores a real expiring device denial and rejects later valid signatures", async () => {
    const sessionA = await session();
    const request = { action: "revoke-device", address: sessionA.wallet.address, authorization: sessionA.authorization, signature: await sessionA.device.signMessage({ message: syncRevokeDeviceMessage(sessionA.grant) }) };
    expect((await call(request)).code).toBe(200);
    expect((await call(await sessionA.write("denied"))).code).toBe(403);
    const revocation = Array.from(ownedKeys).find((key) => key.startsWith(`chirpy:usersync:revoked:${sessionA.wallet.address.toLowerCase()}:`));
    expect(await redis(["PTTL", revocation!])).toBeGreaterThan(0);
  });
});
