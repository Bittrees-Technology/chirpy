import { parseOrg, type OrgConfig } from '@app/core';

export const MAX_SAVED_ORGANIZATIONS = 1000;
export const ORGANIZATIONS_KEY = 'chat:orgs:v2';
export const LEGACY_ORGANIZATIONS_KEY = 'chat:orgs:v1';
export interface OrganizationStore {
  version: 2;
  orgs: OrgConfig[];
  /** Original malformed snapshots, retained verbatim for download/recovery. */
  recovery: string[];
}
export function decodeOrganizationStore(raw: string | null, legacy = false): OrganizationStore {
  const empty: OrganizationStore = { version: 2, orgs: [], recovery: [] };
  if (raw === null) return empty;
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return { ...empty, recovery: [raw] }; }
  let candidates: unknown[];
  let recovery: string[] = [];
  if (legacy && Array.isArray(parsed)) candidates = parsed;
  else if (!legacy && parsed?.version === 2 && Array.isArray(parsed.orgs)
    && Array.isArray(parsed.recovery) && parsed.recovery.length <= 1000 && parsed.recovery.every((item: unknown) => typeof item === 'string')) {
    candidates = parsed.orgs; recovery = parsed.recovery;
  } else return { ...empty, recovery: [raw] };
  // Preserve an oversized store intact rather than iterating an unbounded list at startup.
  if (candidates.length > MAX_SAVED_ORGANIZATIONS) return { ...empty, recovery: [raw] };
  const orgs: OrgConfig[] = [];
  const ids = new Set<string>();
  let rejected = false;
  for (const candidate of candidates) {
    try {
      const org = parseOrg(JSON.stringify(candidate));
      if (ids.has(org.id)) { rejected = true; continue; }
      ids.add(org.id); orgs.push(org);
    } catch { rejected = true; }
  }
  if (rejected && !recovery.includes(raw)) recovery = [...recovery, raw];
  return { version: 2, orgs, recovery };
}
export function loadOrganizationStore(storage: Pick<Storage, 'getItem'>): OrganizationStore {
  const current = storage.getItem(ORGANIZATIONS_KEY);
  return current !== null ? decodeOrganizationStore(current) : decodeOrganizationStore(storage.getItem(LEGACY_ORGANIZATIONS_KEY), true);
}
