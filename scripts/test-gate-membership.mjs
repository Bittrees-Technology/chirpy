// Explicit dev-network membership drill: fresh wallets, no production RPC or rooms.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const image = process.argv[2];
if (!image || process.env.XMTP_MEMBERSHIP_DRILL !== '1') throw new Error('Set XMTP_MEMBERSHIP_DRILL=1 and pass a built gate image.');
const name = `chirpy-membership-${randomUUID()}`; const volume = `${name}-data`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
const script = `import assert from 'node:assert/strict'; import { randomBytes } from 'node:crypto';
import { createGateClientGetter } from './server/gate-client.js';
import { createMembershipRevalidator } from './server/gate-membership.js';
import { createGateProbe } from './server/gate-health.js';
const make = name => createGateClientGetter({ env: { XMTP_GATEKEEPER_PRIVATE_KEY: '0x' + randomBytes(32).toString('hex'), GATE_DB_ENCRYPTION_KEY: randomBytes(32).toString('hex'), GATE_DATA_DIR: '/data/' + name, GATE_XMTP_ENV: 'dev' } })();
const bot = await make('bot'); const alice = await make('alice');
const group = await bot.conversations.createGroup([alice.inboxId]);
const rooms = [{ id: group.id, namespace: 'synthetic', title: 'Recovery drill', chainId: 1, gate: { combine: 'all', rules: [{ kind: 'token', standard: 'erc721', token: '0x' + '1'.repeat(40), min: '1' }] } }];
const probe = createGateProbe({ getClient: async () => bot, getRooms: async () => rooms,
  env: { XMTP_GATEKEEPER_PRIVATE_KEY: '0x' + '1'.repeat(64), GATE_DB_ENCRYPTION_KEY: '2'.repeat(64), GATE_DATA_DIR: '/data/bot', GATE_XMTP_ENV: 'dev', MAINNET_RPC_URL: 'https://rpc.example', GATE_PUBLIC_URL: 'https://gate.example/api/room-join', GATE_ALLOW_ORIGIN: 'https://chirpy.example', CHIRPY_GATE_ROOMS_FILE: '/rooms.json' },
  fetcher: async (_url, options) => ({ ok: true, json: async () => ({ result: JSON.parse(options.body).method === 'eth_chainId' ? '0x1' : { timestamp: '0x' + Math.floor(Date.now()/1000).toString(16) } }) }) });
const readiness = await probe(); assert.equal(readiness.rpc, true); assert.equal(readiness.xmtp, true); assert.match(readiness.registryHash, /^[a-f0-9]{64}$/);
let clock = 1000; let balance = 1n;
const options = { getClient: async () => bot, getRooms: async () => rooms, reader: () => ({ erc721Balance: async () => balance }), now: () => clock };
const audit = createMembershipRevalidator({ ...options, mode: 'audit' });
assert.equal((await audit.checkMember(group.id, alice.inboxId)).status, 'eligible');
balance = 0n; assert.equal((await audit.checkMember(group.id, alice.inboxId)).status, 'observing');
clock += 300001; assert.equal((await audit.checkMember(group.id, alice.inboxId)).status, 'would-remove');
assert.ok((await group.members()).some(member => member.inboxId === alice.inboxId));
const enforce = createMembershipRevalidator({ ...options, mode: 'enforce' });
assert.equal((await enforce.checkMember(group.id, bot.inboxId)).status, 'protected');
assert.equal((await enforce.checkMember(group.id, alice.inboxId)).status, 'observing');
clock += 300001; assert.equal((await enforce.checkMember(group.id, alice.inboxId)).status, 'removed');
await group.sync(); assert.ok(!(await group.members()).some(member => member.inboxId === alice.inboxId));
assert.ok((await group.members()).some(member => member.inboxId === bot.inboxId));
console.log('XMTP dev membership drill passed: bound eligible identity, audit preserves membership, delayed enforcement removes member, bot remains protected. Runtime room authority also verified. RPC and balances use deterministic test responses.'); process.exit(0);`;
try {
  docker(['volume', 'create', volume]);
  const output = docker(['run', '--rm', '--name', name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '-v', `${volume}:/data`, image, '--input-type=module', '-e', script]);
  if (!output.includes('membership drill passed')) throw new Error('Drill did not report completion.');
  console.log(output.trim().split('\n').at(-1));
} catch (error) {
  const diagnostic = String(error.stderr || error.message).replace(/(?:0x)?[a-fA-F0-9]{64}/g, '[redacted]');
  throw new Error(`Membership drill failed: ${diagnostic.slice(-2000)}`);
} finally {
  try { docker(['rm', '-f', name]); } catch { /* --rm runs may already be gone. */ }
  docker(['volume', 'rm', volume]);
}
