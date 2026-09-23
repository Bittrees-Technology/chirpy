import { createHash } from 'node:crypto';
import { createPublicClient, http, recoverMessageAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { profileAddress } from '../packages/core/src/publicProfile.js';
import { displayNetwork, validDisplayWalletRecord, validDisplayWalletCommand, displayWalletSignMessage } from '../packages/core/src/displayWallet.js';
import { publicProfileConfig, PROFILE_CAS } from './public-profile.js';
import { mailKv } from './mail-service.js';
import { syncCors } from './sync-cors.js';
import { checkRateLimit } from './server-utils.js';
export function displayWalletConfig(env = process.env) {
  const profile = publicProfileConfig(env); if (!profile) return null;
  const service = `${profile.service}?kind=display-wallet`;
  return { ...profile, service, prefix: `chat:display-wallet:v1:${createHash('sha256').update(service).digest('hex')}:` };
}
export async function verifyDisplayWalletSignature(config, command, signature) {
  if (!validDisplayWalletCommand(command, config.service) || typeof signature !== 'string' || !/^0x(?:[a-fA-F0-9]{2}){1,4096}$/.test(signature)) return false;
  const message = displayWalletSignMessage(command);
  try { if ((await recoverMessageAddress({ message, signature })).toLowerCase() === command.wallet) return true; } catch {}
  try {
    if (!config.rpc || new URL(config.rpc).protocol !== 'https:') return false;
    const client = createPublicClient({ chain: mainnet, transport: http(config.rpc, { timeout: 8000, retryCount: 0 }) });
    if (await client.getChainId() !== 1) return false;
    return await client.verifyMessage({ address: command.wallet, message, signature });
  } catch { return false; }
}
// A signer owns only its per-wallet/network record. Storage does NOT certify the
// claimed inbox or target linkage: readers must validate both against fresh SDK
// state. This prevents an unrelated signer from replacing an inbox owner's choice.
export function createDisplayWallets(config, kv = mailKv(config)) {
  const key = (wallet, network) => `${config.prefix}${network}:${wallet}`;
  const parse = (raw, wallet, network) => {
    if (raw === null) return { version: 1, wallet, network, inboxId: null, displayWallet: null, revision: 0, updatedAt: 0 };
    if (typeof raw !== 'string' || raw.length > 4096) throw Error('Invalid display choice storage');
    let value; try { value = JSON.parse(raw); } catch { throw Error('Invalid display choice storage'); }
    if (!validDisplayWalletRecord(value, wallet, network)) throw Error('Invalid display choice storage');
    return value;
  };
  return {
    async readMany(wallets, network) {
      if (!displayNetwork(network) || !Array.isArray(wallets) || !wallets.length || wallets.length > 50 || !wallets.every(profileAddress) || new Set(wallets).size !== wallets.length) throw Error('Invalid display choice query');
      const raw = await kv(['MGET', ...wallets.map(wallet => key(wallet, network))]);
      if (!Array.isArray(raw) || raw.length !== wallets.length) throw Error('Invalid display choice storage');
      return raw.map((value, i) => parse(value, wallets[i], network));
    },
    async write(command) {
      if (!validDisplayWalletCommand(command, config.service)) return { status: 'expired' };
      const recordKey = key(command.wallet, command.network);
      const raw = await kv(['GET', recordKey]), current = parse(raw, command.wallet, command.network);
      if (current.revision !== command.revision) return { status: 'conflict' };
      const next = { version: 1, wallet: command.wallet, network: command.network, inboxId: command.inboxId, displayWallet: command.displayWallet, revision: command.revision + 1 };
      const result = await kv(['EVAL', PROFILE_CAS, '1', recordKey, raw ?? '', String(command.expiresAt), JSON.stringify(next)]);
      if (result[0] === -2) return { status: 'expired' };
      if (result[0] === 0) return { status: 'conflict' };
      if (result[0] !== 1) throw Error('Invalid display choice storage');
      return { status: 'saved', choice: parse(result[1], command.wallet, command.network) };
    },
  };
}
export async function handleDisplayWallet(req, res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  const config = displayWalletConfig(); if (!config) return res.status(503).json({ enabled: false, error: 'Display choices are unavailable.' });
  const cors = syncCors(req, res, { service: config.service, allowedOrigins: [process.env.CHIRPY_SYNC_ALLOWED_ORIGINS, process.env.CHIRPY_SYNC_MIGRATION_ORIGINS].filter(Boolean).join(',') });
  if (cors) return res.status(cors.status).json(cors.body);
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST, OPTIONS'); return res.status(405).json({ error: 'Method not allowed.' }); }
  if (!checkRateLimit(req, '/api/profile/display-wallet').allowed) return res.status(429).json({ error: 'Too many requests.' });
  try {
    const choices = createDisplayWallets(config);
    if (req.method === 'GET') {
      const wallets = typeof req.query?.wallet === 'string' && req.query.wallet.length <= 2149 ? req.query.wallet.split(',') : [];
      if (Object.keys(req.query ?? {}).sort().join(',') !== 'kind,network,wallet' || !displayNetwork(req.query.network) || !wallets.length || wallets.length > 50 || !wallets.every(profileAddress) || new Set(wallets).size !== wallets.length) return res.status(400).json({ error: 'Use a network and up to 50 unique wallets.' });
      return res.status(200).json({ service: config.service, choices: await choices.readMany(wallets, req.query.network) });
    }
    if (Object.keys(req.query ?? {}).join(',') !== 'kind') return res.status(400).json({ error: 'Invalid display choice query.' });
    if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return res.status(415).json({ error: 'Use application/json.' });
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 12000) return res.status(413).json({ error: 'Display choice request is too large.' });
    if (!req.body || Object.keys(req.body).sort().join(',') !== 'command,signature' || !await verifyDisplayWalletSignature(config, req.body.command, req.body.signature)) return res.status(401).json({ error: 'Invalid or expired display choice authorization.' });
    const result = await choices.write(req.body.command);
    return res.status({ saved: 200, conflict: 409, expired: 401 }[result.status]).json({ service: config.service, ...result });
  } catch { return res.status(503).json({ error: 'Display choices are unavailable. Reload before retrying.' }); }
}
