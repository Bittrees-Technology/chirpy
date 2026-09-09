import { describe, expect, it } from 'vitest';
import { syncCors } from '../sync-cors.js';
const config = { service: 'https://chirpy.example/api/usersync', allowedOrigins: 'tauri://localhost,http://tauri.localhost,https://tauri.localhost' };
const run = (headers = {}, method = 'POST', options = config) => {
  const output: Record<string, string> = {};
  const result = syncCors({ headers, method }, { setHeader: (key, value) => { output[key] = value; } }, options);
  return { result, headers: output };
};
describe('sync CORS', () => {
  it.each(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'https://chirpy.example'])('allows only the configured exact origin %s', origin => {
    const response = run({ origin }); expect(response.result).toBeNull();
    expect(response.headers['Access-Control-Allow-Origin']).toBe(origin);
    expect(response.headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });
  it.each(['null', 'https://chirpy.example.evil.test', 'https://evil.test', 'tauri://other'])('rejects untrusted origin %s', origin => {
    const response = run({ origin }); expect(response.result?.status).toBe(403);
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
  it('accepts bounded preflights without bypassing mutation authorization', () => {
    expect(run({ origin: 'tauri://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' }, 'OPTIONS').result?.status).toBe(204);
    expect(run({ origin: 'tauri://localhost', 'access-control-request-method': 'DELETE' }, 'OPTIONS').result?.status).toBe(400);
    expect(run({ origin: 'tauri://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization' }, 'OPTIONS').result?.status).toBe(400);
    expect(run({}, 'OPTIONS').result?.status).toBe(400);
  });
  it('refuses wildcard configuration and leaves nonbrowser callers subject to authentication', () => {
    expect(run({}, 'POST', { ...config, allowedOrigins: '*' }).result?.status).toBe(503);
    expect(run().result).toBeNull();
  });
});
