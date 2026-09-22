/** Public discovery only. A catalog entry never grants membership or signing authority. */
export type PushSource = 'governance' | 'research';
export const PUSH_SOURCES = Object.freeze({
  governance: Object.freeze({ name: 'Governance', registry: 'https://gov.bittrees.org/api/rooms', messenger: 'https://gov.bittrees.org/messenger' }),
  research: Object.freeze({ name: 'Research', registry: 'https://research.bittrees.org/api/rooms', messenger: 'https://research.bittrees.org/messenger' }),
});
export type PushGateRule =
  | { kind: 'bgov'; tier: number }
  | { kind: 'safe'; safe: string; ens?: string }
  | { kind: 'token'; standard: 'erc20' | 'erc721' | 'erc1155'; token: string; min: string; tokenId?: string }
  | { kind: 'ens'; name?: string }
  | { kind: 'role'; role: string };
export type PushGate = PushGateRule | { kind: 'multi'; combine: 'any' | 'all'; rules: PushGateRule[] };
export interface PushCatalogRoom {
  id: string;
  source: PushSource;
  key: string;
  chatId: string;
  title: string;
  description: string;
  /** Null means the public registry has no gate descriptor. Never interpret it as open admission. */
  sourceGate: PushGate | null;
}
export interface PushCatalog { source: PushSource; revision: number; rooms: PushCatalogRoom[] }
export const MAX_PUSH_REGISTRY_BYTES = 512 * 1024;
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
function invalid(): never { throw new Error('The source room registry is unavailable or unsupported. Existing rooms have not been changed.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function source(value: unknown): PushSource {
  if (value !== 'governance' && value !== 'research') invalid();
  return value;
}
function chatId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) invalid();
  return value; // Preserve the protocol ID exactly; never invent or convert a room.
}
export function pushConversationId(origin: PushSource, id: string): string { return `push:production:${source(origin)}:${chatId(id)}`; }
export function parsePushConversationId(value: string): { source: PushSource; chatId: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^push:production:(governance|research):([a-fA-F0-9]{64})$/.exec(value);
  return match ? { source: source(match[1]), chatId: chatId(match[2]) } : null;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value)) invalid();
  return value;
}
function rule(value: unknown): PushGateRule {
  const r = object(value);
  const fields: Record<string, string[]> = { bgov: ['kind', 'tier'], safe: ['kind', 'safe', 'ens'], token: ['kind', 'standard', 'token', 'min', 'tokenId'], ens: ['kind', 'name'], role: ['kind', 'role'] };
  if (typeof r.kind !== 'string' || !own(fields, r.kind) || Object.keys(r).some(k => !fields[r.kind as string].includes(k))) invalid();
  if (r.kind === 'bgov') {
    if (typeof r.tier !== 'number' || !Number.isFinite(r.tier) || r.tier < 0) invalid();
    return { kind: 'bgov', tier: r.tier };
  }
  if (r.kind === 'safe') return { kind: 'safe', safe: address(r.safe), ...(r.ens === undefined ? {} : { ens: text(r.ens, 255, 1) }) };
  if (r.kind === 'ens') return { kind: 'ens', ...(r.name === undefined ? {} : { name: text(r.name, 255) }) };
  if (r.kind === 'role') return { kind: 'role', role: text(r.role, 64, 1) };
  if (!['erc20', 'erc721', 'erc1155'].includes(String(r.standard))) invalid();
  const min = text(r.min, 100, 1);
  if (!(r.standard === 'erc20' ? /^\d+(\.\d+)?$/ : /^\d+$/).test(min)) invalid();
  if (r.tokenId !== undefined && (r.standard !== 'erc1155' || !/^\d{1,78}$/.test(text(r.tokenId, 78, 1)))) invalid();
  return { kind: 'token', standard: r.standard as 'erc20' | 'erc721' | 'erc1155', token: address(r.token), min, ...(r.tokenId === undefined ? {} : { tokenId: r.tokenId as string }) };
}
function gate(value: unknown): PushGate {
  const r = object(value);
  if (r.kind !== 'multi') return rule(r);
  if (Object.keys(r).some(k => !['kind', 'combine', 'rules'].includes(k)) || !['any', 'all'].includes(String(r.combine))
    || !Array.isArray(r.rules) || !r.rules.length || r.rules.length > 8) invalid();
  return { kind: 'multi', combine: r.combine as 'any' | 'all', rules: r.rules.map(rule) };
}
/** Unknown registry envelope fields are not copied. Unknown gate semantics reject the catalog. */
export function parsePushRegistry(value: unknown, origin: PushSource): PushCatalog {
  source(origin);
  const data = object(value); const builtin = object(data.rooms);
  if (!Number.isSafeInteger(data.revision) || (data.revision as number) < 0 || !Array.isArray(data.custom)
    || Object.keys(builtin).length + data.custom.length > 1000) invalid();
  const rooms: PushCatalogRoom[] = [];
  const keys = new Set<string>(); const ids = new Set<string>();
  const reserveKey = (key: string) => {
    text(key, 256, 1);
    if (['__proto__', 'constructor', 'prototype'].includes(key) || keys.has(key)) invalid();
    keys.add(key);
  };
  const add = (key: string, id: unknown, title: string, description: string, sourceGate: PushGate | null) => {
    const rawId = chatId(id);
    // Case-only aliases and duplicate IDs would create conflicting descriptions of one room.
    if (ids.has(rawId.toLowerCase())) invalid();
    ids.add(rawId.toLowerCase());
    rooms.push({ id: pushConversationId(origin, rawId), source: origin, key, chatId: rawId, title, description, sourceGate });
  };
  for (const [key, id] of Object.entries(builtin)) {
    reserveKey(key);
    add(key, id, key, `Existing ${PUSH_SOURCES[origin].name} Push room`, null);
  }
  for (const raw of data.custom) {
    const r = object(raw);
    const key = text(r.key, 256, 1); const title = text(r.name, 80, 1); const description = text(r.blurb, 1000);
    reserveKey(key);
    const sourceGate = gate(r.gate);
    // A proposal/configuration with no assigned protocol ID is not a usable room.
    if (r.chatId === undefined || r.chatId === '') continue;
    add(key, r.chatId, title, description, sourceGate);
  }
  return { source: origin, revision: data.revision as number, rooms };
}

/** Fixed public endpoints, bounded streaming body, no credentials or redirects. */
export async function loadPushRegistry(origin: PushSource, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<PushCatalog> {
  const endpoint = PUSH_SOURCES[source(origin)].registry;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => { void reader?.cancel().catch(() => { /* Request already aborted. */ }); };
  const abort = () => { controller.abort(); cancelReader(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, 10_000);
  try {
    const response = await (options.fetch ?? fetch)(endpoint, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (!response.ok || response.redirected || !response.body || controller.signal.aborted) invalid();
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_PUSH_REGISTRY_BYTES) invalid();
    reader = response.body.getReader();
    const parts: Uint8Array[] = []; let size = 0;
    while (true) {
      const result = await reader.read();
      if (controller.signal.aborted) invalid();
      if (result.done) break;
      size += result.value.byteLength; if (size > MAX_PUSH_REGISTRY_BYTES) invalid();
      parts.push(result.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return parsePushRegistry(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), origin);
  } catch { throw new Error('Could not read the source room registry. Try again; no rooms were replaced.'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); cancelReader(); }
}
