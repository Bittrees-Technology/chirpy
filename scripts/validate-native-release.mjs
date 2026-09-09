import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function httpsUrl(value, field, originOnly = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (originOnly && url.origin !== value)) throw new Error();
    return url;
  } catch { throw new Error(`${field} must be an explicit HTTPS ${originOnly ? 'origin' : 'URL'}.`); }
}
export function validateNativeRelease(env, versions) {
  if (!versions.length || versions.some(version => version !== versions[0])) throw new Error('Native and UI release versions must match.');
  if (!/^\d+\.\d+\.\d+$/.test(versions[0]) || env.GITHUB_REF !== `refs/tags/app-v${versions[0]}`) throw new Error('Release must run from the matching app-v version tag.');
  if (env.VITE_TRANSPORT !== 'xmtp' || env.VITE_XMTP_ENV !== 'production') throw new Error('Release must use production XMTP, never mock or dev.');
  httpsUrl(env.VITE_API_ORIGIN, 'VITE_API_ORIGIN', true);
  httpsUrl(env.VITE_MAINNET_RPC_URL, 'VITE_MAINNET_RPC_URL');
  httpsUrl(env.CHIRPY_GATE_HEALTH_URL, 'CHIRPY_GATE_HEALTH_URL');
  const required = ['VITE_WALLETCONNECT_PROJECT_ID', 'TAURI_SIGNING_PRIVATE_KEY'];
  if (env.RUNNER_OS === 'macOS') required.push('APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID');
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing release configuration: ${missing.join(', ')}.`);
}
export async function verifyReleaseServices(env, fetcher = fetch) {
  const webUrl = new URL('/api/health', httpsUrl(env.VITE_API_ORIGIN, 'VITE_API_ORIGIN', true));
  const gateUrl = httpsUrl(env.CHIRPY_GATE_HEALTH_URL, 'CHIRPY_GATE_HEALTH_URL');
  const [webResponse, gateResponse] = await Promise.all([webUrl, gateUrl].map(url => fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })));
  if (!webResponse.ok || !gateResponse.ok) throw new Error('Production services are not ready for a native release.');
  const [web, gate] = await Promise.all([webResponse.json(), gateResponse.json()]);
  if (web.runtime?.transport !== 'xmtp' || web.readiness?.releaseReady !== true || gate.ok !== true || gate.dependencies?.ready !== true) throw new Error('Production service readiness is incomplete; configuration-only gate health is insufficient.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const native = JSON.parse(readFileSync(resolve(root, 'apps/web/src-tauri/tauri.conf.json'), 'utf8')).version;
    const cargo = readFileSync(resolve(root, 'apps/web/src-tauri/Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)?.[1];
    const ui = readFileSync(resolve(root, 'apps/web/src/app.config.ts'), 'utf8').match(/APP_VERSION = "([^"]+)"/)?.[1];
    validateNativeRelease(process.env, [native, cargo, ui]);
    await verifyReleaseServices(process.env);
    console.log('Release inputs and live service readiness verified. Artifacts remain drafts pending acceptance.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
