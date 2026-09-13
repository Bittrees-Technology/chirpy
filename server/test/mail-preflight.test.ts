import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mailPreflight } from '../../scripts/mail-preflight.mjs';

const configured = {
  CHIRPY_MAIL_SERVICE_URL: 'https://mail.example.com/api/mail',
  CHIRPY_MAIL_FROM: 'sender@example.com',
  CHIRPY_MAIL_SENDERS: `0x${'a'.repeat(40)}`,
  CHIRPY_MAIL_DATA_KEY: 'b'.repeat(64),
  CHIRPY_MAIL_WORKER_SECRET: 'private-worker-secret-'.repeat(3),
  RESEND_API_KEY: 'private-provider-secret',
  KV_REST_API_URL: 'https://redis.example.com',
  KV_REST_API_TOKEN: 'private-storage-secret',
  RESEND_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
};

describe('offline mail preflight', () => {
  it('validates paused preparation without changing settings or contacting services', () => {
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    try {
      const env = Object.freeze({ ...configured });
      const report = mailPreflight(env);
      expect(report).toMatchObject({ configurationValid: true, sendingEnabled: false, webhookEnabled: false, missing: [], externalVerificationRequired: true });
      expect(request).not.toHaveBeenCalled();
      const output = JSON.stringify(report);
      for (const value of Object.values(configured)) expect(output).not.toContain(value);
    } finally { request.mockRestore(); }
  });

  it('reports missing names and rejects malformed values without exposing them', () => {
    expect(mailPreflight({}).missing).toContain('CHIRPY_MAIL_DATA_KEY');
    for (const [key, value] of Object.entries({
      CHIRPY_MAIL_SERVICE_URL: 'http://secret.example/api/mail',
      CHIRPY_MAIL_FROM: 'bad private address', CHIRPY_MAIL_SENDERS: 'bad-wallet',
      CHIRPY_MAIL_DATA_KEY: 'bad-key', CHIRPY_MAIL_WORKER_SECRET: 'short',
      KV_REST_API_URL: 'http://private-storage', RESEND_WEBHOOK_SECRET: 'bad-webhook-secret',
    })) {
      const report = mailPreflight({ ...configured, [key]: value });
      expect(report.configurationValid).toBe(false);
      expect(report.missing).toEqual([]);
      expect(JSON.stringify(report)).not.toContain(value);
    }
  });

  it('preserves preview restrictions, activation flags and storage aliases', () => {
    const active = { ...configured, CHIRPY_MAIL_ENABLED: '1', CHIRPY_MAIL_WEBHOOK_ENABLED: '1' };
    expect(mailPreflight(active)).toMatchObject({ sendingEnabled: true, webhookEnabled: true });
    expect(mailPreflight({ ...active, VERCEL_ENV: 'preview' })).toMatchObject({ configurationValid: false, sendingEnabled: false, webhookEnabled: false });
    expect(mailPreflight({ ...active, KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: configured.KV_REST_API_URL, UPSTASH_REDIS_REST_TOKEN: configured.KV_REST_API_TOKEN }).configurationValid).toBe(true);
  });

  it('provides automation exit codes without echoing unexpected arguments', () => {
    const run = (env: Record<string, string>, args: string[] = []) => spawnSync(process.execPath, ['scripts/mail-preflight.mjs', ...args], { env, encoding: 'utf8' });
    const good = run(configured);
    expect(good.status).toBe(0);
    expect(JSON.parse(good.stdout).externalVerificationRequired).toBe(true);
    expect(run({}).status).toBe(1);
    const bad = run(configured, ['accidental-secret']);
    expect(bad.status).toBe(2);
    expect(bad.stdout + bad.stderr).not.toContain('accidental-secret');
  });
});
