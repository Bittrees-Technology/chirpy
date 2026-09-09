import { describe, expect, it, vi } from 'vitest';
import { validateNativeRelease, verifyReleaseServices } from '../../scripts/validate-native-release.mjs';
const env = { GITHUB_REF: 'refs/tags/app-v1.2.3', VITE_TRANSPORT: 'xmtp', VITE_XMTP_ENV: 'production', VITE_API_ORIGIN: 'https://chirpy.example', VITE_MAINNET_RPC_URL: 'https://rpc.example', CHIRPY_GATE_HEALTH_URL: 'https://gate.example/health', VITE_WALLETCONNECT_PROJECT_ID: 'synthetic-project', TAURI_SIGNING_PRIVATE_KEY: 'synthetic-only', RUNNER_OS: 'Linux' };
describe('native release gates', () => {
  it('accepts consistent tagged production configuration', () => {
    expect(() => validateNativeRelease(env, ['1.2.3', '1.2.3', '1.2.3'])).not.toThrow();
  });
  it.each([{ GITHUB_REF: 'refs/heads/main' }, { VITE_TRANSPORT: 'mock' }, { VITE_XMTP_ENV: 'dev' }, { TAURI_SIGNING_PRIVATE_KEY: '' }, { VITE_WALLETCONNECT_PROJECT_ID: '' }, { VITE_API_ORIGIN: 'http://chirpy.example' }, { RUNNER_OS: 'macOS' }])('rejects incomplete release inputs: %j', override => {
    expect(() => validateNativeRelease({ ...env, ...override }, ['1.2.3', '1.2.3', '1.2.3'])).toThrow();
  });
  it('rejects version drift', () => {
    expect(() => validateNativeRelease(env, ['1.2.3', '1.2.4', '1.2.3'])).toThrow('versions');
  });
  it.each([
    [{ runtime: { transport: 'mock' }, readiness: { releaseReady: true } }, { ok: true, dependencies: { ready: true } }],
    [{ runtime: { transport: 'xmtp' }, readiness: { releaseReady: false } }, { ok: true, dependencies: { ready: true } }],
    [{ runtime: { transport: 'xmtp' }, readiness: { releaseReady: true } }, { ok: true }],
  ])('refuses mock, degraded or configuration-only service readiness', async (web, gate) => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => web }).mockResolvedValueOnce({ ok: true, json: async () => gate });
    await expect(verifyReleaseServices(env, fetcher)).rejects.toThrow('readiness');
  });
  it('requires both live services and refuses redirects', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ runtime: { transport: 'xmtp' }, readiness: { releaseReady: true } }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, dependencies: { ready: true } }) });
    await expect(verifyReleaseServices(env, fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(new URL('https://gate.example/health'), expect.objectContaining({ redirect: 'error' }));
  });
});
