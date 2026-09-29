import { expect, it, vi } from 'vitest';
import { createGovernanceRoleReader, probeGovernanceRoles } from '../gate-role-authority.js';
import { evalGate, validateProductionGate } from '../../packages/core/src/gating.ts';
import { membershipEligibility } from '../gate-membership.js';
const wallet = '0x' + 'a'.repeat(40);
const gate = { combine: 'any', rules: [{ kind: 'role', role: 'Associate', authority: 'bittrees-governance' }] };
const reply = (access = true, status = access ? 200 : 403, extra = {}, headers = {}) => new Response(JSON.stringify({ access, roleSourceReady: true, combine: 'any', rules: 1, ...extra }), { status, headers: { 'content-type': 'application/json', ...headers } });
it('pins the authority, exact policy and wallet; shares only in-decision requests', async () => {
  const fetcher = vi.fn(async () => reply()); const rolesOf = createGovernanceRoleReader({ fetcher });
  expect(await rolesOf(wallet)).toEqual(['associate', 'junior partner', 'partner']);
  await rolesOf(wallet); expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [url, opts] of fetcher.mock.calls as any) {
    const parsed = new URL(url); expect(parsed.origin).toBe('https://gov.bittrees.org');
    expect(parsed.pathname.endsWith(`/${wallet}/checkAccess`)).toBe(true);
    const policy = JSON.parse(Buffer.from(parsed.pathname.split('/')[4], 'base64url').toString());
    expect(policy.rules).toHaveLength(1); expect(['Associate','Junior Partner','Partner']).toContain(policy.rules[0].role);
    expect(opts).toMatchObject({ redirect: 'error', cache: 'no-store' }); expect(opts.signal).toBeInstanceOf(AbortSignal);
  }
  await createGovernanceRoleReader({ fetcher })(wallet); expect(fetcher).toHaveBeenCalledTimes(6);
});
it('admits qualified wallets and treats confirmed revocation as ineligible', async () => {
  expect(validateProductionGate(gate)).toBe(true);
  for (const allowed of [true, false]) {
    const reader = { rolesOf: createGovernanceRoleReader({ fetcher: async () => reply(allowed) }) } as any;
    expect(await evalGate(gate as any, wallet, reader, { roleCascade: {}, powerTier: null })).toBe(allowed);
    expect(await membershipEligibility(gate, wallet, reader)).toBe(allowed ? 'eligible' : 'ineligible');
  }
});
it.each([
  ['outage', () => reply(false, 503)], ['legacy', () => reply(false, 403, { roleSourceReady: undefined })],
  ['not ready', () => reply(false, 403, { roleSourceReady: false })], ['contradiction', () => reply(true, 403)],
  ['wrong policy', () => reply(true, 200, { rules: 2 })], ['wrong combination', () => reply(true, 200, { combine: 'all' })],
  ['stale', () => reply(true, 200, {}, { age: '60' })], ['redirect', () => new Response('', { status: 302 })],
  ['html', () => new Response('login')], ['oversize', () => new Response(' '.repeat(4097), { headers: { 'content-type': 'application/json' } })],
  ['transport', () => { throw new Error('private detail'); }],
])('denies admission and preserves members for %s', async (_name, response) => {
  const reader = { rolesOf: createGovernanceRoleReader({ fetcher: async () => response() }) } as any;
  expect(await evalGate(gate as any, wallet, reader, { roleCascade: {}, powerTier: null })).toBe(false);
  expect(await membershipEligibility(gate, wallet, reader)).toBe('unknown');
  await expect(reader.rolesOf(wallet)).rejects.toThrow('Governance role authority unavailable.');
});
it('rejects unapproved authorities, roles and wallet namespaces before requests', async () => {
  for (const rule of [{ kind:'role',role:'Associate' }, { kind:'role',role:'admin',authority:'bittrees-governance' }, { kind:'role',role:'Associate',authority:'other' }]) expect(validateProductionGate({ ...gate, rules:[rule] })).toBe(false);
  const fetcher = vi.fn(); const rolesOf = createGovernanceRoleReader({ fetcher });
  for (const value of ['eip155:'+wallet, wallet+'\n', 'https://evil.test', '0x1']) await expect(rolesOf(value)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('checks role availability only when a managed room depends on it', async () => {
  const fetcher = vi.fn(async () => reply(false));
  await probeGovernanceRoles([{gate:{rules:[{kind:'ens'}]}}], {fetcher}); expect(fetcher).not.toHaveBeenCalled();
  await probeGovernanceRoles([{gate}], {fetcher}); expect(fetcher).toHaveBeenCalledTimes(3);
  await expect(probeGovernanceRoles([{gate}], {fetcher:async()=>reply(false,503)})).rejects.toThrow();
});
