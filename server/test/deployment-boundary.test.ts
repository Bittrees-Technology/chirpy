import { afterEach, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import handler from "../../api/room-join.js";
import { buildHealthReport } from "../ops-utils.js";
import { resetRateLimits } from "../server-utils.js";
afterEach(() => { vi.restoreAllMocks(); resetRateLimits(); });
it("ships only the intended API entrypoints", () => {
  expect(readdirSync(new URL('../../api/', import.meta.url)).filter(name => name !== 'node_modules').sort()).toEqual([
    'health.js', 'package.json', 'room-join.js', 'usersync.js', 'workflow-event.js',
  ]);
  const route = readFileSync(new URL('../../api/room-join.js', import.meta.url), 'utf8');
  expect(route).not.toMatch(/import\s*(?:\(|.*from).*(@xmtp|\.ts|server\/room-join)/);
});
it("responds without starting the gatekeeper even if credentials are configured", () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const res = { code: 0, body: null as any, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } };
  handler({ method: 'POST', body: { action: 'catalog' } }, res);
  expect(res.code).toBe(503);
  expect(res.body.error).toContain('external gate');
  expect(res.headers['Cache-Control']).toBe('no-store');
  handler({ method: 'GET' }, res);
  expect(res.code).toBe(405);
  const report = buildHealthReport({ VITE_TRANSPORT: 'xmtp', XMTP_GATEKEEPER_PRIVATE_KEY: 'configured', MAINNET_RPC_URL: 'https://rpc.example' });
  expect(report.readiness.embeddedGateReady).toBe(false);
  expect(report.readiness.gateReady).toBe(false);
});
