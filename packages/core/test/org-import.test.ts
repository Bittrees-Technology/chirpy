import { expect, it } from 'vitest';
import { createOrg, parseOrg, serializeOrg, validateOrgConfig } from '../src/org';
import { PRESETS } from '../../../apps/web/src/presets';

const original = () => createOrg({ name: 'Import test' });
it.each([
  ['branding.name', { name: {} }],
  ['branding.themeCss', { themeCss: {} }],
  ['branding.slug', { slug: [] }],
])('rejects malformed %s before it reaches rendering', (_, patch) => {
  const org = original(); Object.assign(org.branding, patch);
  expect(() => parseOrg(JSON.stringify(org))).toThrow('Invalid org config');
});
it.each([
  ['chain', { chainId: 1.5 }], ['chain', { chainId: -1 }],
  ['roles', {}], ['roles', [{ label: {} }]], ['admins', ['not-an-address']],
  ['defaultRooms', 'rooms'], ['defaultRooms', [{ id: 'room', title: 'Room', gate: null }]],
  ['gating', []], ['gating', { enableSafeRules: 'false' }], ['gating', { roleCascade: [] }],
  ['gating', { powerTier: { label: 'Power', resolver: 'custom', tiers: [1], params: { space: {} } } }],
  ['policy', { mode: 'typo' }], ['policy', { attachments: 'blocked' }], ['policy', { maxUploadBytes: -1 }],
  ['entryGate', [null]], ['entryGate', [{ kind: 'unknown' }]],
  ['entryGate', [{ kind: 'safe', safe: 'wrong' }]], ['entryGate', [{ kind: 'power', tier: '1' }]],
  ['entryGate', [{ kind: 'token', standard: 'erc20', token: '0x' + '1'.repeat(40), min: 'Infinity' }]],
  ['entryGate', [{ kind: 'ens', name: {} }]], ['gateUrl', {}], ['id', 'org_personal'],
])('rejects an invalid %s field', (key, value) => {
  const org = { ...original(), [key]: value };
  expect(() => parseOrg(JSON.stringify(org))).toThrow('Invalid org config');
});
it('defaults absent legacy collections without accepting malformed present collections', () => {
  const legacy = { version: 1, branding: { name: 'Legacy' }, namespace: 'legacy', chain: { chainId: 1 }, entryGate: [], gating: {} };
  const imported = parseOrg(JSON.stringify(legacy));
  expect(imported.defaultRooms).toEqual([]); expect(imported.roles).toEqual([]); expect(imported.admins).toEqual([]);
  expect(imported.branding.slug).toBe('legacy');
  expect(imported.gating).toMatchObject({ enableTokenRules: true, roleCascade: {}, powerTier: null });
  expect(imported.policy).toEqual({ mode: 'active', attachments: 'allow' });
  expect(parseOrg(serializeOrg(imported))).toEqual(imported);
});
it('round trips current presets without treating schema validity as production gate support', () => {
  for (const preset of PRESETS) expect(parseOrg(serializeOrg(preset.org))).toEqual(preset.org);
});
it('bounds UTF-8 import size, collection sizes and error output', () => {
  expect(() => parseOrg(JSON.stringify({ ...original(), extra: 'é'.repeat(128_000) }))).toThrow('256 KB');
  const org = original(); org.roles = Array.from({ length: 1001 }, () => ({ label: 'role' }));
  expect(() => parseOrg(serializeOrg(org))).toThrow('roles');
  org.roles = Array.from({ length: 1000 }, () => ({ label: null } as any));
  expect(validateOrgConfig(org).errors).toHaveLength(20);
});
it('rejects duplicate seed IDs and arbitrary JSON without throwing inside validation', () => {
  const org = original(); const room = { id: 'same', title: 'Room', gate: { combine: 'any' as const, rules: [] } };
  org.defaultRooms = [room, room]; expect(() => parseOrg(serializeOrg(org))).toThrow('defaultRooms');
  for (const value of [null, [], true, 42, 'org', {}, { branding: null, gating: null }]) {
    expect(validateOrgConfig(value).ok).toBe(false);
    expect(() => parseOrg(JSON.stringify(value))).toThrow('Invalid org config');
  }
});
