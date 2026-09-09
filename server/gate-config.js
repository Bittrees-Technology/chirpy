import { isAbsolute } from 'node:path';
export function validGatekeeperKey(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) > 0n && BigInt(value) < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
}
export function validDatabaseKey(value) {
  return typeof value === 'string' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(value) && !/^(?:0x)?0{64}$/.test(value);
}
export function readGateClientConfig(env = process.env) {
  if (!validGatekeeperKey(env.XMTP_GATEKEEPER_PRIVATE_KEY)) throw new Error('A valid gatekeeper key is required.');
  if (!validDatabaseKey(env.GATE_DB_ENCRYPTION_KEY)) throw new Error('A persistent 32-byte database encryption key is required.');
  const databaseKeyHex = env.GATE_DB_ENCRYPTION_KEY.replace(/^0x/, '').toLowerCase();
  if (databaseKeyHex === env.XMTP_GATEKEEPER_PRIVATE_KEY.slice(2).toLowerCase()) throw new Error('Use separate wallet and database encryption keys.');
  if (!isAbsolute(env.GATE_DATA_DIR || '')) throw new Error('An explicit persistent database directory is required.');
  const network = env.GATE_XMTP_ENV || 'production';
  if (!['production', 'dev'].includes(network)) throw new Error('Invalid gate XMTP network.');
  return { privateKey: env.XMTP_GATEKEEPER_PRIVATE_KEY, databaseKey: new Uint8Array(Buffer.from(databaseKeyHex, 'hex')), dataDir: env.GATE_DATA_DIR, network };
}
