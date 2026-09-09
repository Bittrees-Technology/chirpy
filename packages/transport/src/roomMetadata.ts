import { mergePolicy, validateProductionGate, type Gate, type Policy } from '@app/core';

export const ROOM_META_VERSION = 1;
export const MAX_ROOM_DESCRIPTION_LENGTH = 10000;
export interface RoomMeta {
  gate: Gate;
  policy: Policy;
  description?: string;
  namespace?: string;
  invalid?: true;
}
export const INVALID_ROOM_METADATA = 'Room configuration is invalid or unsupported. Ask an administrator to repair it.';
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const openGate = (): Gate => ({ combine: 'any', rules: [] });
const namespace = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

/** Decode untrusted room metadata without converting a damaged gate into open access. */
export function parseRoomMeta(description: unknown, orgPolicy: Policy): RoomMeta {
  const invalid = (scope?: unknown): RoomMeta => ({ gate: openGate(), policy: { mode: 'read-only', attachments: 'block' },
    description: INVALID_ROOM_METADATA, namespace: namespace(scope) ? scope : undefined, invalid: true });
  if (description === undefined || description === '') return { gate: openGate(), policy: mergePolicy(orgPolicy) };
  if (typeof description !== 'string' || description.length > 65536 || new TextEncoder().encode(description).length > 65536) return invalid();
  const fallback = { gate: openGate(), policy: mergePolicy(orgPolicy), description };
  let parsed: unknown;
  try { parsed = JSON.parse(description); }
  catch { return /"chirpyRoom"\s*:/.test(description) ? invalid() : fallback; }
  if (!object(parsed) || !Object.hasOwn(parsed, 'chirpyRoom')) return fallback;
  if (parsed.chirpyRoom !== ROOM_META_VERSION) return invalid(parsed.namespace);
  try {
    if (parsed.namespace !== undefined && !namespace(parsed.namespace)) return invalid();
    if (parsed.description !== undefined && (typeof parsed.description !== 'string' || parsed.description.length > MAX_ROOM_DESCRIPTION_LENGTH)) return invalid(parsed.namespace);
    let gate: unknown = parsed.gate ?? openGate();
    if (parsed.gate === null) return invalid(parsed.namespace);
    if (typeof gate === 'string') {
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(gate)) return invalid(parsed.namespace);
      const binary = atob(gate.replace(/-/g, '+').replace(/_/g, '/'));
      gate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    }
    if (!object(gate) || !['all', 'any'].includes(gate.combine) || !Array.isArray(gate.rules)
      || (gate.rules.length > 0 && !validateProductionGate(gate))) return invalid(parsed.namespace);
    const policy = parsed.policy;
    if (policy !== undefined && (!object(policy)
      || (policy.mode !== undefined && !['active', 'read-only'].includes(policy.mode))
      || (policy.attachments !== undefined && !['allow', 'block'].includes(policy.attachments))
      || (policy.maxUploadBytes !== undefined && (!Number.isSafeInteger(policy.maxUploadBytes) || policy.maxUploadBytes < 0)))) return invalid(parsed.namespace);
    return { gate: gate as Gate, policy: mergePolicy(orgPolicy, policy), description: parsed.description, namespace: parsed.namespace };
  } catch { return invalid(parsed.namespace); }
}
