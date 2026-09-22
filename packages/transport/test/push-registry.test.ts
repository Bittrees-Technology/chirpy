import { describe, expect, it, vi } from 'vitest';
import { loadPushRegistry, MAX_PUSH_REGISTRY_BYTES, parsePushConversationId, parsePushRegistry, pushConversationId } from '../src/pushRegistry';
const id = 'a'.repeat(64); const other = 'b'.repeat(64);
const registry = () => ({ rooms: { shareholders: id }, custom: [], revision: 1 });
describe('Push room discovery boundary', () => {
  it('preserves original protocol IDs without pretending an undescribed gate is open', () => {
    const result = parsePushRegistry(registry(), 'governance');
    expect(result.rooms[0]).toMatchObject({ chatId: id, sourceGate: null, source: 'governance' });
    expect(parsePushConversationId(result.rooms[0].id)).toEqual({ source: 'governance', chatId: id });
    expect(result.rooms[0]).not.toHaveProperty('isMember');
    expect(parsePushConversationId(id)).toBeNull();
    expect(pushConversationId('research', id)).not.toBe(result.rooms[0].id);
    expect(parsePushConversationId(`push:dev:governance:${id}`)).toBeNull();
  });
  it('keeps custom gates in their original protocol and ignores unassigned room configurations', () => {
    const gate = { kind: 'multi', combine: 'all', rules: [{ kind: 'role', role: 'Partner' }, { kind: 'safe', safe: `0x${'1'.repeat(40)}` }] };
    const result = parsePushRegistry({ ...registry(), custom: [{ key: 'custom', name: 'Discussion', blurb: 'Existing room', gate, chatId: other }, { key: 'unassigned', name: 'Draft', blurb: '', gate }] }, 'governance');
    expect(result.rooms).toHaveLength(2); expect(result.rooms[1].sourceGate).toEqual(gate);
    expect(result.rooms[1].sourceGate).not.toBe(gate);
  });
  it('rejects malformed, ambiguous and unsupported catalogs', () => {
    for (const value of [null, {}, { ...registry(), revision: -1 }, { ...registry(), rooms: { one: id, two: id.toUpperCase() } },
      { ...registry(), rooms: { one: '../bad' } }, { ...registry(), custom: [{ key: 'x', name: 'x', blurb: '', chatId: other, gate: { kind: 'multi', combine: 'anything', rules: [] } }] }]) {
      expect(() => parsePushRegistry(value, 'governance')).toThrow();
    }
    expect(() => parsePushRegistry({ rooms: {}, custom: [], revision: 0 }, 'untrusted' as any)).toThrow();
    expect(parsePushRegistry({ rooms: {}, custom: [], revision: 0 }, 'research').rooms).toEqual([]);
  });
  it('reads only fixed public endpoints with no credential or redirect forwarding', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(registry())));
    const result = await loadPushRegistry('governance', { fetch: request as any });
    expect(result.rooms).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('https://gov.bittrees.org/api/rooms', expect.objectContaining({ credentials: 'omit', redirect: 'error', cache: 'no-store' }));
  });
  it('rejects unavailable, oversized and corrupt responses instead of returning an empty catalog', async () => {
    for (const response of [new Response('{}', { status: 503 }), new Response('bad'), new Response(' '.repeat(MAX_PUSH_REGISTRY_BYTES + 1)),
      new Response('{}', { headers: { 'content-length': String(MAX_PUSH_REGISTRY_BYTES + 1) } }), new Response(new Uint8Array([255, 254]))]) {
      await expect(loadPushRegistry('governance', { fetch: async () => response })).rejects.toThrow('no rooms were replaced');
    }
  });
  it('rejects duplicate keys even when a configuration has no room ID', () => {
    expect(() => parsePushRegistry({ ...registry(), custom: [{ key: 'shareholders', name: 'Draft', blurb: '', gate: { kind: 'role', role: 'Partner' } }] }, 'governance')).toThrow();
  });
  it('cancels a stalled body when the caller disconnects', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const pending = loadPushRegistry('governance', { signal: controller.signal, fetch: async () => new Response(body) });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow('no rooms were replaced');
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('enforces the deadline while waiting for body data', async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      const pending = loadPushRegistry('governance', { fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })) });
      const rejected = expect(pending).rejects.toThrow('no rooms were replaced');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(cancelled).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('does not accept a response after the caller aborts', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(loadPushRegistry('research', { signal: controller.signal, fetch: async () => new Response(JSON.stringify(registry())) })).rejects.toThrow();
  });
});
