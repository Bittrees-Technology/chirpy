import { pathToFileURL } from 'node:url';
import { mailConfig } from '../server/mail-service.js';
import { mailEventConfig } from '../server/mail-events.js';

// Offline only: reuse runtime validation without returning configuration values.
export function mailPreflight(env = process.env) {
  const required = [
    ['CHIRPY_MAIL_SERVICE_URL'], ['CHIRPY_MAIL_FROM'], ['CHIRPY_MAIL_SENDERS'],
    ['CHIRPY_MAIL_DATA_KEY'], ['CHIRPY_MAIL_WORKER_SECRET'], ['RESEND_API_KEY'],
    ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL'],
    ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'], ['RESEND_WEBHOOK_SECRET'],
  ];
  const missing = required.filter(names => !names.some(name => env[name]))
    .map(names => names.join(' or '));
  // Test preparation while paused; never override the preview deployment guard.
  const prepared = { ...env, CHIRPY_MAIL_ENABLED: '1', CHIRPY_MAIL_WEBHOOK_ENABLED: '1' };
  const sendingConfigurationValid = Boolean(mailConfig(prepared));
  const webhookConfigurationValid = Boolean(mailEventConfig(prepared));
  return {
    configurationValid: sendingConfigurationValid && webhookConfigurationValid,
    sendingConfigurationValid,
    webhookConfigurationValid,
    sendingEnabled: Boolean(mailConfig(env)),
    webhookEnabled: Boolean(mailEventConfig(env)),
    missing,
    externalVerificationRequired: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('Use node scripts/mail-preflight.mjs with settings in the environment.');
    process.exitCode = 2;
  } else {
    const report = mailPreflight();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.configurationValid ? 0 : 1;
  }
}
