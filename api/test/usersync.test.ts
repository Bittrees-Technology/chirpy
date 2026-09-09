import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { resetRateLimits } from "../server-utils.js";
const account = privateKeyToAccount(`0x${"3".repeat(64)}`);
const auth = "Chirpy sync — authorize device writes (v1)\n\nSign to let this device save your encrypted sync blob. Gas-free; proves wallet ownership only.";
let handler; let record; let storageDown;
beforeEach(async () => {
  vi.resetModules(); resetRateLimits(); record = null; storageDown = false;
  vi.stubEnv("KV_REST_API_URL", "https://kv.example"); vi.stubEnv("KV_REST_API_TOKEN", "test");
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    if (storageDown) return { ok: false, status: 503 };
    const cmd = JSON.parse(options.body); let result;
    if (cmd[0] === "GET") result = record ? JSON.stringify(record) : null;
    else if (cmd[0] === "EVAL") {
      expect(cmd[1]).toContain("redis.call('SET'");
      const revision = record?.revision ?? 0;
      if (revision !== Number(cmd[4])) result = [0, revision];
      else { record = { ...JSON.parse(cmd[5]), revision: revision + 1 }; result = [1, revision + 1]; }
    } else throw new Error("Expected atomic EVAL, not separate GET/SET");
    return { ok: true, json: async () => ({ result }) };
  }));
  handler = (await import("../usersync.js")).default;
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function call(body, method = "POST") {
  const res = { code: 0, body: null as any, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method, query: { address: account.address }, body: { address: account.address, signature: await account.signMessage({ message: auth }), ...body } }, res); return res;
}
it("allows only one of two writes based on the same revision", async () => {
  const writes = await Promise.all([call({ expectedRevision: 0, blob: "first" }), call({ expectedRevision: 0, blob: "second" })]);
  expect(writes.map((w) => w.code).sort()).toEqual([200, 409]); expect(record.blob).toBe("first");
  expect((await call({ expectedRevision: 1, blob: "merged" })).code).toBe(200);
  expect(record).toMatchObject({ blob: "merged", revision: 2 });
});
it("rejects old clients and ignores user-controlled timestamps", async () => {
  expect((await call({ blob: "legacy", updatedAt: 999999999999999 })).code).toBe(409);
  expect((await call({ blob: "new", expectedRevision: 0, updatedAt: 999999999999999 })).code).toBe(200);
  expect(record.updatedAt).toBeLessThan(999999999999999);
});
it("reports a storage outage instead of an empty record", async () => {
  storageDown = true; expect((await call({}, "GET")).code).toBe(503);
  expect((await call({ blob: "new", expectedRevision: 0 })).code).toBe(503);
  expect(record).toBeNull();
});
