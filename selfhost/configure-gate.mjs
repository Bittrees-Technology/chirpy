import { randomBytes } from 'node:crypto';
import { writeFile, lstat, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const { privateKeyToAccount } = createRequire(new URL('../server/package.json', import.meta.url))('viem/accounts');
import { readGateClientConfig } from '../server/gate-config.js';
import { loadRooms } from '../server/room-join.js';

export async function configureGate(env = process.env, directory = fileURLToPath(new URL('.', import.meta.url))) {
  for (const name of ['gate.env', 'rooms.json']) {
    try { await lstat(resolve(directory, name)); throw new Error('Existing configuration must not be overwritten.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const domain = env.GATE_SETUP_DOMAIN || '';
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(domain)) throw new Error('Enter a valid public gate domain.');
  const httpsUrl = value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || /[\s'"$#\\]/.test(value)) throw new Error('Use an HTTPS URL without credentials or dotenv control characters.');
    return url;
  };
  const origin = env.GATE_SETUP_ORIGIN || '';
  if (httpsUrl(origin).origin !== origin) throw new Error('The web origin must contain no path or trailing slash.');
  const rpc = env.GATE_SETUP_RPC || ''; httpsUrl(rpc);
  const registryPath = resolve(env.GATE_SETUP_REGISTRY || '');
  // Use the same trusted-registry validation as admission, before creating secret files.
  const rooms = await loadRooms(registryPath);
  if (!rooms.length) throw new Error('A reviewed registry with at least one room is required.');
  const privateKey = env.XMTP_GATEKEEPER_PRIVATE_KEY || `0x${randomBytes(32).toString('hex')}`;
  const databaseKey = randomBytes(32).toString('hex');
  readGateClientConfig({ XMTP_GATEKEEPER_PRIVATE_KEY: privateKey, GATE_DB_ENCRYPTION_KEY: databaseKey, GATE_DATA_DIR: '/data' });
  const address = privateKeyToAccount(privateKey).address;
  const config = {
    GATE_DOMAIN: domain, GATE_PORT: '8788', GATE_ALLOW_ORIGIN: origin, MAINNET_RPC_URL: rpc,
    XMTP_GATEKEEPER_PRIVATE_KEY: privateKey, GATE_DB_ENCRYPTION_KEY: databaseKey,
    GATE_DATA_DIR: '/data', GATE_XMTP_ENV: 'production',
    GATE_PUBLIC_URL: `https://${domain}/api/room-join`, CHIRPY_GATE_ROOMS_FILE: '/config/rooms.json',
  };
  // Exclusive creation also protects against another installer winning the race.
  // A partial failure is left for deliberate operator recovery, never overwrite/rekey.
  await writeFile(resolve(directory, 'gate.env'), Object.entries(config).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(directory, 'rooms.json'), JSON.stringify(rooms, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  await chmod(resolve(directory, 'rooms.json'), 0o644);
  return address;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('Configuration saved. Gatekeeper address:', await configureGate()); }
  catch (error) { console.error('Configuration was not completed:', error.message); process.exitCode = 1; }
}
