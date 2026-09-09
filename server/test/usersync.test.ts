import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToHex } from "viem";
import { syncGrantMessage, syncWriteMessage, syncRevokeDeviceMessage, syncRevokeAllMessage } from "../../packages/core/src/syncAuth";
const account = privateKeyToAccount(`0x${"3".repeat(64)}`);
const device = privateKeyToAccount(`0x${"4".repeat(64)}`);
const service = "https://chirpy.example/api/usersync";
let handler; let records: Map<string,string>; let storageDown;
beforeEach(async () => {
  vi.resetModules(); records = new Map(); storageDown = false;
  vi.stubEnv("KV_REST_API_URL", "https://kv.example"); vi.stubEnv("KV_REST_API_TOKEN", "test"); vi.stubEnv("CHIRPY_SYNC_SERVICE_URL", service);
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    if (storageDown) return { ok: false, status: 503 };
    const cmd = JSON.parse(options.body); let result;
    if (cmd[0] === "MGET") result = cmd.slice(1).map((key) => records.get(key) ?? null);
    else if (cmd[0] === "EVAL") {
      const count = Number(cmd[2]); const keys = cmd.slice(3, 3 + count); const args = cmd.slice(3 + count);
      if (count === 3) {
        expect(cmd[1]).toContain("redis.call('EXISTS', KEYS[3])");
        const epoch = Number(records.get(keys[1]) ?? 0);
        const current = JSON.parse(records.get(keys[0]) ?? '{}'); const revision = current.revision ?? 0;
        if (epoch !== Number(args[2]) || records.has(keys[2])) result = [-1, epoch];
        else if (revision !== Number(args[0])) result = [0, revision];
        else { records.set(keys[0], JSON.stringify({ ...JSON.parse(args[1]), revision: revision + 1 })); result = [1, revision + 1]; }
      } else {
        const epoch = Number(records.get(keys[0]) ?? 0);
        if (epoch !== Number(args[0])) result = [0, epoch];
        else if (count === 1) { records.set(keys[0], String(epoch + 1)); result = [1, epoch + 1]; }
        else { records.set(keys[1], '1'); result = [1, epoch]; }
      }
    } else throw new Error("Expected atomic EVAL or MGET");
    return { ok: true, json: async () => ({ result }) };
  }));
  handler = (await import("../../api/usersync.js")).default;
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function grant(overrides = {}) {
  const value = { version: 2 as const, service, address: account.address, device: device.address, epoch: 0, issuedAt: Date.now(), expiresAt: Date.now() + 3_600_000, ...overrides };
  return { ...value, signature: await account.signMessage({ message: syncGrantMessage(value) }) };
}
async function write(blob = "encrypted", expectedRevision = 0, authorization?: any) {
  authorization ??= await grant();
  return { action: "write", address: account.address, authorization, blob, expectedRevision, signature: await device.signMessage({ message: syncWriteMessage(authorization, expectedRevision, keccak256(stringToHex(blob))) }) };
}
async function call(body = {}, method = "POST", extraHeaders = {}) {
  const res = { code: 0, body: null as any, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method, headers: { "content-type": "application/json", ...extraHeaders }, query: { address: account.address }, body }, res); return res;
}
it("allows only one of two writes at a revision and rejects captured write replay", async () => {
  const first = await write("first"); const second = await write("second");
  const results = await Promise.all([call(first), call(second)]);
  expect(results.map((r) => r.code).sort()).toEqual([200,409]);
  expect((await call(first)).code).toBe(409);
  expect((await call(await write("merged", 1))).code).toBe(200);
});
it.each(["blob", "expectedRevision", "signature"])("rejects tampering with %s", async (field) => {
  const request = await write();
  request[field] = field === "blob" ? "modified" : field === "expectedRevision" ? 1 : await account.signMessage({ message: "wrong key" });
  expect((await call(request)).code).toBe(401);
  expect(records.size).toBe(0);
});
it.each([{ service: "https://other.example/api/usersync" }, { issuedAt: Date.now() - 10_000, expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 48 * 3_600_000 }, { address: device.address }])("rejects wrong-service, expired, overlong and wrong-wallet grants %#", async (overrides) => {
  expect((await call(await write("blob", 0, await grant(overrides)))).code).toBe(401);
  expect(records.size).toBe(0);
});
it("revokes one device grant and atomically rejects its later write", async () => {
  const authorization = await grant();
  const revoke = { action: "revoke-device", address: account.address, authorization, signature: await device.signMessage({ message: syncRevokeDeviceMessage(authorization) }) };
  expect((await call(revoke)).code).toBe(200);
  expect((await call(await write("denied", 0, authorization))).code).toBe(403);
});
it("revoke-all invalidates prior grants and cannot be replayed against a fresh epoch", async () => {
  const authorization = await grant(); const expiresAt = Date.now() + 60_000;
  const revoke = { action: "revoke-all", address: account.address, epoch: 0, expiresAt, signature: await account.signMessage({ message: syncRevokeAllMessage(service, account.address, 0, expiresAt) }) };
  expect((await call(revoke)).code).toBe(200);
  expect((await call(await write("denied", 0, authorization))).code).toBe(403);
  expect((await call(revoke)).code).toBe(409);
  expect((await call(await write("new", 0, await grant({ epoch: 1 })))).code).toBe(200);
});
it("rejects v1 signatures and uses server timestamps", async () => {
  expect((await call({ address: account.address, blob: "old", signature: await account.signMessage({ message: "Chirpy sync — authorize device writes (v1)" }) })).code).toBe(401);
  expect((await call({ ...await write(), updatedAt: 99999999999999 })).code).toBe(200);
  expect((await call({}, "GET")).body.updatedAt).toBeLessThan(99999999999999);
});
it("reports storage outages without treating them as empty records", async () => {
  storageDown = true;
  expect((await call({}, "GET")).code).toBe(503);
  expect((await call(await write())).code).toBe(503);
  expect(records.size).toBe(0);
});

it("allows configured native preflight but still requires signed writes", async () => {
  vi.stubEnv("CHIRPY_SYNC_ALLOWED_ORIGINS", "tauri://localhost");
  expect((await call({}, "OPTIONS", { origin: "tauri://localhost", "access-control-request-method": "POST", "access-control-request-headers": "content-type" })).code).toBe(204);
  expect(fetch).not.toHaveBeenCalled();
  expect((await call({ address: account.address, action: "write" }, "POST", { origin: "tauri://localhost" })).code).toBe(401);
  expect(records.size).toBe(0);
  expect((await call(await write(), "POST", { origin: "tauri://localhost" })).code).toBe(200);
  expect((await call(await write("blocked", 1), "POST", { origin: "https://evil.test" })).code).toBe(403);
});
