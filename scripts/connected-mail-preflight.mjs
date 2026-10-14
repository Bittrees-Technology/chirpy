import { pathToFileURL } from 'node:url';
import { connectedMailConfig } from '../server/connected-mail-config.js';

// Offline configuration evidence only; never report values or contact services.
export function connectedMailPreflight(env = process.env) {
  const required = [
    ['CHAT_CONNECTED_MAIL_KEY'],
    ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL'],
    ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'],
  ];
  const prepared = connectedMailConfig(env, { allowDisabled: true });
  return {
    configurationValid: Boolean(prepared),
    enabled: Boolean(connectedMailConfig(env)),
    disconnectAvailable: Boolean(prepared),
    previewBlocked: Boolean(env.VERCEL_ENV && env.VERCEL_ENV !== 'production'),
    acceptanceAllowlistConfigured: Boolean(prepared?.testWallets.length),
    contractWalletRpcConfigured: Boolean(env.MAINNET_RPC_URL),
    missing: required.filter(names => !names.some(name => env[name])).map(names => names.join(' or ')),
    externalVerificationRequired: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('Use node scripts/connected-mail-preflight.mjs with settings in the environment.');
    process.exitCode = 2;
  } else {
    const report = connectedMailPreflight();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.configurationValid ? 0 : 1;
  }
}
