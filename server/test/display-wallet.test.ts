import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { displayWalletSignMessage, selectDisplayWallet } from '../../packages/core/src/displayWallet.js';
import { profileSignMessage } from '../../packages/core/src/publicProfile.js';
import { createDisplayWallets, displayWalletConfig, verifyDisplayWalletSignature } from '../display-wallet.js';
import handler from '../../api/profile.js';
import { resetRateLimits } from '../server-utils.js';
const signer = privateKeyToAccount(`0x${'3'.repeat(64)}`), other = privateKeyToAccount(`0x${'4'.repeat(64)}`);
const wallet = signer.address.toLowerCase(), target = other.address.toLowerCase(), inbox = 'a'.repeat(64);
const service = 'https://chat.example/api/profile?kind=display-wallet';
const command = (patch = {}) => ({ version: 1 as const, service, wallet, network: 'dev' as const, inboxId: inbox, displayWallet: target, revision: 0, expiresAt: Date.now() + 60000, ...patch });
let records: Map<string, string>;
beforeEach(() => {
  resetRateLimits(); records = new Map(); vi.stubEnv('VERCEL_ENV', 'production'); vi.stubEnv('CHIRPY_SYNC_SERVICE_URL', 'https://chat.example/api/usersync'); vi.stubEnv('KV_REST_API_URL', 'https://kv.example'); vi.stubEnv('KV_REST_API_TOKEN', 'synthetic'); vi.stubEnv('MAINNET_RPC_URL', '');
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const cmd = JSON.parse(init.body); let result;
    if (cmd[0] === 'GET') result = records.get(cmd[1]) ?? null;
    else if (cmd[0] === 'MGET') result = cmd.slice(1).map(key => records.get(key) ?? null);
    else if (cmd[0] === 'EVAL') {
      const key = cmd[3], raw = cmd[4], expiry = Number(cmd[5]), next = JSON.parse(cmd[6]);
      if (Date.now() >= expiry) result = [-2];
      else if ((records.get(key) ?? '') !== raw) result = [0];
      else { next.updatedAt = Date.now(); records.set(key, JSON.stringify(next)); result = [1, JSON.stringify(next)]; }
    } else throw Error('Unexpected Redis command');
    return Response.json({ result });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function call(body: any = {}, method = 'POST', query: any = method === 'GET' ? { kind: 'display-wallet', wallet, network: 'dev' } : { kind: 'display-wallet' }, headers: any = {}) {
  const res = { code: 0, body: null as any, headers: {} as Record<string, string>, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method, body, query, headers: { 'content-type': 'application/json', ...headers } }, res); return res;
}
async function signed(c = command(), account = signer) { return { command: c, signature: await account.signMessage({ message: displayWalletSignMessage(c as any) }) }; }
it('publishes only the signed wallet/network choice and permanently fences old intent after reset', async () => {
  const first = await signed(); expect((await call(first)).code).toBe(200);
  const read = await call({}, 'GET'); expect(read.headers['Cache-Control']).toBe('no-store');
  expect(read.body.choices[0]).toMatchObject({ wallet, network: 'dev', inboxId: inbox, displayWallet: target, revision: 1 });
  expect((await call(await signed(command({ revision: 1, displayWallet: null })))).code).toBe(200);
  expect((await call(first)).code).toBe(409); expect((await call({}, 'GET')).body.choices[0]).toMatchObject({ displayWallet: null, revision: 2 });
  expect(JSON.stringify([...records])).not.toContain(first.signature); expect(JSON.stringify([...records])).not.toContain(target);
});
it('isolates networks and leaves the existing name/profile protocol unchanged', async () => {
  expect((await call(await signed())).code).toBe(200);
  expect((await call({}, 'GET', { kind: 'display-wallet', wallet, network: 'production' })).body.choices[0].revision).toBe(0);
  expect((await call({}, 'GET', { wallet })).body.profiles[0]).toMatchObject({ wallet, label: null, revision: 0 });
  const profile = { version: 1 as const, service: 'https://chat.example/api/profile', wallet, revision: 0, label: 'Independent name', expiresAt: Date.now() + 60000 };
  expect((await call({ command: profile, signature: await signer.signMessage({ message: profileSignMessage(profile) }) }, 'POST', {})).code).toBe(200);
  expect((await call({}, 'GET')).body.choices[0].displayWallet).toBe(target);
  expect((await call({}, 'GET', { wallet })).body.profiles[0].label).toBe('Independent name');
});
it('rejects another signer and any changed signed field before storage', async () => {
  const req = await signed();
  for (const patch of [{ wallet: target }, { displayWallet: wallet }, { inboxId: 'b'.repeat(64) }, { network: 'production' }, { service: service + 'x' }, { revision: 1 }]) expect((await call({ ...req, command: { ...req.command, ...patch } })).code).toBe(401);
  expect((await call(await signed(command(), other))).code).toBe(401); expect(records.size).toBe(0);
  const legacy = await signer.signMessage({ message: profileSignMessage({ version: 1, service: 'https://chat.example/api/profile', wallet, revision: 0, label: null, expiresAt: Date.now() + 60000 }) });
  expect(await verifyDisplayWalletSignature(displayWalletConfig(), command(), legacy)).toBe(false);
});
it('an unrelated signer cannot overwrite another wallet or impose a claimed inbox association', async () => {
  const owner = await call(await signed()); expect(owner.code).toBe(200);
  const stranger = privateKeyToAccount(`0x${'5'.repeat(64)}`), strangerWallet = stranger.address.toLowerCase();
  const request = command({ wallet: strangerWallet, displayWallet: strangerWallet });
  expect((await call(await signed(request, stranger))).code).toBe(200);
  const fetched = await call({}, 'GET', { kind: 'display-wallet', wallet: [wallet, target, strangerWallet].join(','), network: 'dev' });
  const relevant = fetched.body.choices.filter(choice => [wallet, target].includes(choice.wallet));
  expect(selectDisplayWallet(relevant, inbox, 'dev', [wallet, target])).toBe(target);
  expect((await call({}, 'GET')).body.choices[0]).toEqual(owner.body.choice);
});
it('serializes conflicting writes and preserves corrupted storage without resetting revisions', async () => {
  const results = await Promise.all([call(await signed()), call(await signed(command({ displayWallet: null })))]);
  expect(results.map(result => result.code).sort()).toEqual([200, 409]);
  const key = displayWalletConfig().prefix + 'dev:' + wallet; records.set(key, 'corrupt private bytes');
  expect((await call({}, 'GET')).code).toBe(503); expect((await call(await signed())).code).toBe(503); expect(records.get(key)).toBe('corrupt private bytes');
  const kv = vi.fn(); expect(await createDisplayWallets(displayWalletConfig(), kv).write(command({ expiresAt: Date.now() - 1 }))).toEqual({ status: 'expired' }); expect(kv).not.toHaveBeenCalled();
});
it('bounds batches, request shape, methods and origins; disables previews', async () => {
  for (const query of [{ kind: 'display-wallet' }, { kind: 'display-wallet', wallet: [wallet], network: 'dev' }, { kind: 'display-wallet', wallet: wallet + ',' + wallet, network: 'dev' }, { kind: 'display-wallet', wallet, network: 'local' }, { kind: 'display-wallet', wallet, network: 'dev', extra: 'x' }]) expect((await call({}, 'GET', query)).code).toBe(400);
  expect((await call({}, 'DELETE')).code).toBe(405); expect((await call({}, 'POST', { kind: 'display-wallet', extra: 'x' })).code).toBe(400);
  expect((await call({}, 'POST', undefined, { 'content-type': 'text/plain' })).code).toBe(415);
  expect((await call({ padding: 'x'.repeat(12001) })).code).toBe(413);
  expect((await call({}, 'GET', undefined, { origin: 'https://attacker.example' })).code).toBe(403);
  vi.stubEnv('CHIRPY_SYNC_MIGRATION_ORIGINS', 'https://new.example'); expect((await call({}, 'GET', undefined, { origin: 'https://new.example' })).code).toBe(200);
  vi.stubEnv('CHIRPY_RATE_LIMIT_MAX', '1'); resetRateLimits(); expect((await call({}, 'GET')).code).toBe(200); expect((await call({}, 'GET')).code).toBe(429);
  vi.stubEnv('VERCEL_ENV', 'preview'); expect((await call({}, 'GET')).code).toBe(503);
});
it('checks contract signatures on configured mainnet only and fails closed on RPC failure', async () => {
  const config = { ...displayWalletConfig(), rpc: 'https://rpc.example' }; let chain = '0x1', result = '0x1'; const methods: string[] = [];
  vi.mocked(fetch).mockImplementation(async (_url, init) => { const req = JSON.parse(init!.body as string); methods.push(req.method); return Response.json({ jsonrpc: '2.0', id: req.id, result: req.method === 'eth_chainId' ? chain : result }); });
  expect(await verifyDisplayWalletSignature(config, command(), '0x1234')).toBe(true); expect(methods).toContain('eth_call');
  chain = '0x89'; methods.length = 0; expect(await verifyDisplayWalletSignature(config, command(), '0x1234')).toBe(false); expect(methods).toEqual(['eth_chainId']);
  chain = '0x1'; result = '0x0'; expect(await verifyDisplayWalletSignature(config, command(), '0x1234')).toBe(false);
  vi.mocked(fetch).mockRejectedValue(Error('offline')); expect(await verifyDisplayWalletSignature(config, command(), '0x1234')).toBe(false);
});
