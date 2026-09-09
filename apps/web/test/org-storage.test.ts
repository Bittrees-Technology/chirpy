import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createOrg } from '@app/core';
import { decodeOrganizationStore, loadOrganizationStore, ORGANIZATIONS_KEY, LEGACY_ORGANIZATIONS_KEY } from '../src/orgStorage';
import { OrgProvider, useOrgs } from '../src/state';

afterEach(() => vi.unstubAllGlobals());
it.each(['{broken', 'null', '{}', '42'])('preserves malformed saved data %s verbatim', raw => {
  expect(decodeOrganizationStore(raw, true)).toEqual({ version: 2, orgs: [], recovery: [raw] });
});
it('keeps valid organizations and retains the original mixed snapshot across reloads', () => {
  const valid = createOrg({ name: 'Valid' });
  const raw = JSON.stringify([valid, { ...valid, id: 'bad', roles: {} }, valid, { ...valid, id: 'org_personal' }]);
  const recovered = decodeOrganizationStore(raw, true);
  expect(recovered.orgs).toEqual([valid]); expect(recovered.recovery).toEqual([raw]);
  expect(decodeOrganizationStore(JSON.stringify(recovered))).toEqual(recovered);
});
it('prefers the new store and never writes over legacy storage', () => {
  const storage = { getItem: vi.fn((key: string) => key === ORGANIZATIONS_KEY ? JSON.stringify({ version: 2, orgs: [], recovery: [] }) : 'invalid legacy') };
  expect(loadOrganizationStore(storage).recovery).toEqual([]);
  expect(storage.getItem).toHaveBeenCalledTimes(1);
  storage.getItem.mockImplementation(key => key === LEGACY_ORGANIZATIONS_KEY ? 'invalid legacy' : null as any);
  expect(loadOrganizationStore(storage).recovery).toEqual(['invalid legacy']);
});
it.each(['read', 'write'])('reports a storage %s failure without discarding the source', async failure => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const raw = JSON.stringify([createOrg({ name: 'Preserved' })]);
  const writes = vi.fn(() => { if (failure === 'write') throw new Error('Quota exceeded'); });
  vi.stubGlobal('localStorage', { getItem: (key: string) => {
    if (failure === 'read' && key === ORGANIZATIONS_KEY) throw new Error('Access denied');
    return key === LEGACY_ORGANIZATIONS_KEY ? raw : null;
  }, setItem: writes });
  let state: ReturnType<typeof useOrgs>;
  function Probe() { state = useOrgs(); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(React.createElement(OrgProvider, null, React.createElement(Probe))));
    expect(state.organizationStorageError).toBe(true);
    expect(writes.mock.calls.some(call => call[0] === LEGACY_ORGANIZATIONS_KEY)).toBe(false);
    if (failure === 'read') {
      expect(writes.mock.calls.some(call => call[0] === ORGANIZATIONS_KEY)).toBe(false);
      expect(() => state.addOrg(createOrg({ name: 'New' }))).toThrow('could not be read');
    } else expect(state.orgs.some(org => org.branding.name === 'Preserved')).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

it('rejects additions beyond the reload limit but permits replacement and removal at capacity', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const orgs = Array.from({ length: 999 }, (_, i) => ({ ...createOrg({ name: `Org ${i}` }), id: `org_${i}` }));
  const saved = new Map([[ORGANIZATIONS_KEY, JSON.stringify({ version: 2, orgs, recovery: [] })]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
  let state: ReturnType<typeof useOrgs>;
  function Probe() { state = useOrgs(); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(React.createElement(OrgProvider, null, React.createElement(Probe))));
    const final = createOrg({ name: 'Final slot' });
    await act(async () => {
      state.addOrg(final);
      // Calls in the same render must not bypass the limit through a stale closure.
      expect(() => state.addOrg(createOrg({ name: 'Overflow' }))).toThrow('Organization limit reached');
    });
    expect(state.orgs).toHaveLength(1001); // Includes Personal.
    const replacement = { ...final, branding: { ...final.branding, name: 'Updated' } };
    await act(async () => state.addOrg(replacement));
    expect(state.activeOrg.branding.name).toBe('Updated');
    await act(async () => {
      state.removeOrg(final.id);
      state.addOrg(createOrg({ name: 'Reused slot' }));
    });
    const reloaded = loadOrganizationStore({ getItem: key => saved.get(key) ?? null });
    expect(reloaded.orgs).toHaveLength(1000);
    expect(reloaded.recovery).toEqual([]);
    expect(reloaded.orgs.at(-1)?.branding.name).toBe('Reused slot');
  } finally { await act(async () => root.unmount()); }
});
