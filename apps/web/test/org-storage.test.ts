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
