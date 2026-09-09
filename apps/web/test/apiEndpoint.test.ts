import { afterEach, describe, expect, it, vi } from 'vitest';
import { pullRemoteBlob } from '../src/userSync';
import { resolveSyncEndpoint } from '../src/apiEndpoint';
describe('sync endpoint configuration', () => {
  it('uses the web origin by default', () => {
    expect(resolveSyncEndpoint(undefined, 'https://chirpy.example/chat')).toEqual({ requestUrl: '/api/usersync', service: 'https://chirpy.example/api/usersync' });
  });
  it.each(['tauri://localhost/', 'http://tauri.localhost/', 'https://tauri.localhost/'])('requires an explicit endpoint for %s', href => {
    expect(() => resolveSyncEndpoint(undefined, href)).toThrow('native build');
    expect(resolveSyncEndpoint('https://chirpy.example', href)).toEqual({ requestUrl: 'https://chirpy.example/api/usersync', service: 'https://chirpy.example/api/usersync' });
  });
  it.each(['http://api.example', 'https://api.example/path', 'https://api.example/', 'https://user:pass@api.example', 'https://api.example?x=1'])('rejects unsafe API origin %s', origin => {
    expect(() => resolveSyncEndpoint(origin, 'tauri://localhost/')).toThrow();
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('contacts only the configured service and rejects a mismatched authorization identity', async () => {
  vi.stubEnv('VITE_API_ORIGIN', 'https://sync.example');
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ blob: null, revision: 0, epoch: 0, authVersion: 2, service: 'https://other.example/api/usersync' }) });
  vi.stubGlobal('fetch', fetcher);
  await expect(pullRemoteBlob('native-test')).rejects.toThrow('wrong origin');
  expect(fetcher).toHaveBeenCalledWith('https://sync.example/api/usersync?address=native-test', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
});
