import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { once } from "node:events";
import { createGateServer } from "../../selfhost/gate-server.mjs";
import { checkRateLimit, resetRateLimits } from "../server-utils.js";

let server; let url; let handler;
beforeEach(async () => {
  resetRateLimits(); vi.spyOn(console, "info").mockImplementation(() => {});
  handler = vi.fn(async (_req, res) => res.status(200).json({ ok: true }));
  server = createGateServer({ handler, registry: async () => [], env: { GATE_ALLOW_ORIGIN: "https://chirpy.example" } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}/api/room-join`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const post = (body, extra = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...extra }, body });

describe("HTTP boundary hardening", () => {
  it("rejects malformed JSON and non-object payloads before the handler", async () => {
    for (const body of ["", "{", "{} trailing", "null", "[]", '"text"', "true", "42"]) expect((await post(body)).status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    expect((await post('{}')).status).toBe(200);
  });
  it("rejects unsupported methods, content types, compressed bodies and origins", async () => {
    expect((await fetch(url)).status).toBe(405);
    expect((await post('{}', { "content-type": "text/plain" })).status).toBe(415);
    expect((await post('{}', { "content-encoding": "gzip" })).status).toBe(415);
    expect((await post('{}', { origin: "https://attacker.example" })).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const accepted = await post('{}', { origin: "https://chirpy.example" });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("access-control-allow-origin")).toBe("https://chirpy.example");
    expect(accepted.headers.get("x-content-type-options")).toBe("nosniff");
    expect(accepted.headers.get("cache-control")).toBe("no-store");
  });
  it("allows only the supported CORS preflight", async () => {
    const options = (method, headers = "content-type") => fetch(url, { method: "OPTIONS", headers: { origin: "https://chirpy.example", "access-control-request-method": method, "access-control-request-headers": headers } });
    expect((await options("POST")).status).toBe(204);
    expect((await options("DELETE")).status).toBe(400);
    expect((await options("POST", "authorization")).status).toBe(400);
  });
  it("caps both declared and chunked request bodies", async () => {
    expect((await post(JSON.stringify({ padding: "x".repeat(33000) }))).status).toBe(413);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.write('{"padding":"'); req.write("x".repeat(33000)); req.end('"}');
    });
    expect(status).toBe(413); expect(handler).not.toHaveBeenCalled();
  });
  it("returns sanitized errors and survives handler failure", async () => {
    handler.mockRejectedValueOnce(new Error("secret-key=/private/path"));
    const response = await post('{}'); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret-key");
    expect((await post('{}')).status).toBe(200);
  });
  it("applies rate limits despite forged forwarding headers", async () => {
    vi.stubEnv("CHIRPY_RATE_LIMIT_MAX", "2");
    expect((await post('{}', { "x-forwarded-for": "1.1.1.1" })).status).toBe(200);
    expect((await post('{}', { "x-forwarded-for": "2.2.2.2" })).status).toBe(200);
    const denied = await post('{}', { "x-forwarded-for": "3.3.3.3", "x-real-ip": "4.4.4.4" });
    expect(denied.status).toBe(429); expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("does not log arbitrary URL path content", async () => {
    await fetch(url.replace("/api/room-join", "/secret-wallet-signature"));
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("secret-wallet-signature");
  });
  it("bounds slow-client connection settings", () => {
    expect(server.headersTimeout).toBeLessThanOrEqual(10000);
    expect(server.requestTimeout).toBeLessThanOrEqual(10000);
    expect(server.maxHeadersCount).toBe(40);
  });
});
it("trusts only explicitly configured proxy peers and their last appended client hop", () => {
  vi.stubEnv("CHIRPY_RATE_LIMIT_MAX", "1"); vi.stubEnv("CHIRPY_TRUSTED_PROXIES", "127.0.0.1");
  const req = (xff) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": xff } });
  expect(checkRateLimit(req("1.1.1.1, 2.2.2.2"), "proxy").allowed).toBe(true);
  expect(checkRateLimit(req("3.3.3.3, 2.2.2.2"), "proxy").allowed).toBe(false);
});
