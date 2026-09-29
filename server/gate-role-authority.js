import { makeViemChainReader } from '../packages/core/src/viemChainReader.ts';

const roles = Object.freeze(['Associate', 'Junior Partner', 'Partner']);
const authority = 'https://gov.bittrees.org';
const unavailable = () => new Error('Governance role authority unavailable.');

// One reader belongs to one admission/revalidation decision, never a durable cache.
// Governance evaluates hierarchy; these are satisfied predicates, not copied assignments.
export function createGovernanceRoleReader({ fetcher = fetch, signal } = {}) {
  const decisions = new Map();
  return async address => {
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address) || address.trim() !== address) throw unavailable();
    const wallet = address.toLowerCase();
    if (!decisions.has(wallet)) decisions.set(wallet, Promise.all(roles.map(async role => {
      const policy = Buffer.from(JSON.stringify({ kind: 'multi', combine: 'any', rules: [{ kind: 'role', role }] })).toString('base64url');
      try {
        const response = await fetcher(`${authority}/api/gate/multi/${policy}/${wallet}/checkAccess`, {
          redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
        });
        if (![200, 403].includes(response.status) || response.redirected ||
            !response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw unavailable();
        const age = response.headers.get('age');
        if (age !== null && (!/^\d+$/.test(age) || Number(age) > 30)) throw unavailable();
        const reader = response.body?.getReader();
        if (!reader) throw unavailable();
        let size = 0; const chunks = [];
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > 4096) throw unavailable(); chunks.push(value);
          }
        } finally { await reader.cancel(); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body?.roleSourceReady !== true || body.combine !== 'any' || body.rules !== 1 ||
            typeof body.access !== 'boolean' || body.access !== (response.status === 200) || body.error) throw unavailable();
        return body.access ? role.toLowerCase() : null;
      } catch { throw unavailable(); }
    })).then(values => values.filter(value => value !== null)));
    return decisions.get(wallet);
  };
}

export function makeGateChainReader(rpcUrl, options = {}) {
  return makeViemChainReader(rpcUrl, { rolesOf: createGovernanceRoleReader(options) });
}

export async function probeGovernanceRoles(rooms, options = {}) {
  if (rooms.some(room => room.gate?.rules?.some(rule => rule.kind === 'role'))) {
    await createGovernanceRoleReader(options)('0x0000000000000000000000000000000000000001');
  }
}
