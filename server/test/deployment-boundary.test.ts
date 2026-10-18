import projectAdministration from '../../api/project-admin.js';
import { afterEach, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import handler from "../../api/room-join.js";
import { buildHealthReport } from "../ops-utils.js";
import { resetRateLimits } from "../server-utils.js";
afterEach(() => { vi.restoreAllMocks(); resetRateLimits(); });
it("ships only the intended API entrypoints", () => {
  expect(readdirSync(new URL('../../api/', import.meta.url)).filter(name => name !== 'node_modules').sort()).toEqual([
    'health.js', 'mail', 'mail-events.js', 'mail-inbound.js', 'mail-optout.js', 'mail-worker.js', 'mail.js', 'package.json', 'profile.js', 'project-admin.js', 'room-join.js', 'sso', 'usersync.js', 'workflow-event.js',
  ]);
  expect(readdirSync(new URL('../../api/mail/', import.meta.url))).toEqual(['[action].js']);
  expect(readdirSync(new URL('../../api/sso/', import.meta.url))).toEqual(['[action].js']);
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

it('staff administration rejects local organization claims and requires a server-verified shared session',async()=>{
 const response={statusCode:0,headers:{},body:'',setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;}};
 await projectAdministration({method:'GET',url:'/api/project-admin/access?identity=0x1111111111111111111111111111111111111111',headers:{cookie:'org-admin=1; bt_session=unverified-owner'}},response);
 expect(response.statusCode).toBe(401);expect(JSON.parse(response.body).error).toContain('Sign in');expect(response.headers['cache-control']).toContain('no-store');
});
