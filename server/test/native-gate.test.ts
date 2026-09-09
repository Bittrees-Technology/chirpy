import { afterEach, expect, it } from 'vitest';
import { createGateServer } from '../../selfhost/gate-server.mjs';
import { createJoinHandler } from '../room-join.js';
const servers: any[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))); });
async function start(nativeOrigins = 'tauri://localhost,http://tauri.localhost,https://tauri.localhost') {
  const server = createGateServer({ env: { GATE_ALLOW_ORIGIN: 'https://chirpy.example', GATE_NATIVE_ORIGINS: nativeOrigins }, handler: createJoinHandler({ getRooms: async () => [] }) });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/api/room-join`;
}
it.each(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'])('allows configured native origin %s without bypassing admission', async origin => {
  const url = await start();
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
  const unsigned = await fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'join', nonce: 'missing' }) });
  expect(unsigned.status).toBe(401);
});
it('rejects unlisted native and hostile web origins', async () => {
  const url = await start('');
  for (const origin of ['tauri://localhost', 'https://evil.example']) {
    const response = await fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(403); expect(response.headers.get('access-control-allow-origin')).toBeNull();
  }
});
it('refuses wildcard or arbitrary origins in the native allowlist', () => {
  for (const GATE_NATIVE_ORIGINS of ['*', 'null', 'https://evil.example']) expect(() => createGateServer({ env: { GATE_NATIVE_ORIGINS } })).toThrow('Tauri origins');
});
