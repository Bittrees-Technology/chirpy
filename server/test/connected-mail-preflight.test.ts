import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { connectedMailPreflight } from '../../scripts/connected-mail-preflight.mjs';

const configured = {
  CHAT_CONNECTED_MAIL_KEY: 'a'.repeat(64),
  KV_REST_API_URL: 'https://private-storage.example',
  KV_REST_API_TOKEN: 'private-token',
  CHAT_CONNECTED_MAIL_TEST_WALLETS: `0x${'b'.repeat(40)}`,
  MAINNET_RPC_URL: 'https://private-rpc.example/secret',
};

describe('offline connected Mail preflight', () => {
  it('checks paused configuration without activation, network access or secret output', () => {
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    try {
      const report = connectedMailPreflight(Object.freeze({ ...configured }));
      expect(report).toMatchObject({ configurationValid: true, enabled: false, disconnectAvailable: true, acceptanceAllowlistConfigured: true, contractWalletRpcConfigured: true, missing: [], externalVerificationRequired: true });
      expect(request).not.toHaveBeenCalled();
      for (const value of Object.values(configured)) expect(JSON.stringify(report)).not.toContain(value);
    } finally { request.mockRestore(); }
  });

  it('matches runtime rejection of invalid keys, endpoints and allowlists without printing values', () => {
    for (const [key, value] of Object.entries({ CHAT_CONNECTED_MAIL_KEY: 'private-invalid-key', KV_REST_API_URL: 'https://user:secret@storage.example', CHAT_CONNECTED_MAIL_TEST_WALLETS: 'private-invalid-wallet' })) {
      const report = connectedMailPreflight({ ...configured, [key]: value });
      expect(report.configurationValid).toBe(false);
      expect(report.missing).toEqual([]);
      expect(JSON.stringify(report)).not.toContain(value);
    }
    expect(connectedMailPreflight({}).missing).toHaveLength(3);
  });

  it('preserves preview guards and distinguishes active and unrestricted configuration', () => {
    const active = { ...configured, CHAT_CONNECTED_MAIL_ENABLED: '1' };
    expect(connectedMailPreflight(active).enabled).toBe(true);
    expect(connectedMailPreflight({ ...active, VERCEL_ENV: 'preview' })).toMatchObject({ configurationValid: false, enabled: false, disconnectAvailable: false, previewBlocked: true });
    expect(connectedMailPreflight({ ...active, CHAT_CONNECTED_MAIL_TEST_WALLETS: '' }).acceptanceAllowlistConfigured).toBe(false);
    expect(connectedMailPreflight({ ...active, KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: configured.KV_REST_API_URL, UPSTASH_REDIS_REST_TOKEN: configured.KV_REST_API_TOKEN }).configurationValid).toBe(true);
  });

  it('returns bounded automation exit codes and rejects unexpected arguments without echoing them', () => {
    const run = (env: Record<string, string>, args: string[] = []) => spawnSync(process.execPath, ['scripts/connected-mail-preflight.mjs', ...args], { env, encoding: 'utf8' });
    expect(run(configured).status).toBe(0);
    expect(run({}).status).toBe(1);
    const rejected = run(configured, ['private-command-line-secret']);
    expect(rejected.status).toBe(2);
    expect(rejected.stdout + rejected.stderr).not.toContain('private-command-line-secret');
  });
});
