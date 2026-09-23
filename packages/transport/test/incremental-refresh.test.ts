import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';

function source() {
  let waiting: ((value: IteratorResult<any>) => void) | undefined;
  const queue: any[] = [];
  let closed = false;
  return {
    [Symbol.asyncIterator]() { return this; },
    next(): Promise<IteratorResult<any>> {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => { waiting = resolve; });
    },
    push(value: any) {
      if (waiting) { const resolve = waiting; waiting = undefined; resolve({ value, done: false }); }
      else queue.push(value);
    },
    async return() { closed = true; waiting?.({ value: undefined, done: true }); waiting = undefined; return { value: undefined, done: true }; },
  };
}
async function setup(count = 3, createConsent?: () => Promise<any>) {
  const t = new XmtpTransport(PERSONAL_ORG, { address: '0x0000000000000000000000000000000000000001' }, null) as any;
  const records: any[] = Array.from({ length: count }, (_, i) => ({ id: String(i), version: 0, consent: 1, metadata: { conversationType: 'dm' } }));
  const stream = source();
  let options: any;
  const api = { sync: vi.fn(), syncAll: vi.fn(), list: vi.fn(async () => [...records]),
    getConversationById: vi.fn(async (id: string) => records.find(record => record.id === id)),
    streamAllMessages: vi.fn(async (value: any) => { options = value; return stream; }) };
  const consentStream = source();
  t.client = { conversations: api, inboxId: 'self', preferences: { streamConsent: vi.fn(createConsent ?? (async () => consentStream)) } }; t.status = 'ready';
  t.sdk = { ConversationType: { Group: 'group' }, ConsentState: { Allowed: 1, Denied: 2 } };
  const summarize = (record: any) => ({ id: record.id, kind: 'dm', title: `revision ${record.version}`, peers: [], unread: 0, blocked: record.consent === 2 });
  t.mapConversation = vi.fn(async (record: any) => summarize(record));
  t.publishedRooms = vi.fn().mockResolvedValue([]);
  const changed = vi.fn();
  const stop = t.subscribe(changed);
  await vi.waitFor(() => expect(api.streamAllMessages).toHaveBeenCalledOnce());
  await t.listConversations();
  t.mapConversation.mockClear(); changed.mockClear();
  return { t, records, stream, consentStream, api, changed, summarize, options: () => options,
    close: async () => { stop(); await vi.waitFor(() => expect(t.streamRunning).toBe(false)); } };
}

it('remaps only the affected conversation in a 10,000-conversation streamed inbox', async () => {
  const f = await setup(10_000);
  try {
    f.records[777].version = 1;
    f.stream.push({ conversationId: '777' });
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledOnce());
    const list = await f.t.listConversations();
    expect(list).toHaveLength(10_000);
    expect(list.find((c: any) => c.id === '777').title).toBe('revision 1');
    expect(f.api.list).toHaveBeenCalledOnce();
    expect(f.api.getConversationById).toHaveBeenCalledExactlyOnceWith('777');
    expect(f.t.mapConversation).toHaveBeenCalledOnce();
    expect(f.api.syncAll).toHaveBeenCalledOnce();
    expect(f.api.sync).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('discovers new local SDK records and prunes removed summaries during incremental refresh', async () => {
  const f = await setup();
  try {
    f.records.shift(); f.records.push({ id: 'new', version: 1 });
    const list = await f.t.listConversations();
    expect(list.map((c: any) => c.id)).toEqual(['1', '2', 'new']);
    expect(f.t.mapConversation).toHaveBeenCalledOnce();
    expect(f.t.mappedConversations.has('0')).toBe(false);
    expect(f.api.syncAll).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('retains a second invalidation that arrives while the same summary is being mapped', async () => {
  const f = await setup();
  let release!: () => void;
  try {
    f.records[0].version = 1; f.t.invalidateConversation('0');
    f.t.mapConversation.mockImplementationOnce(async (record: any) => {
      const snapshot = f.summarize(record);
      await new Promise<void>(resolve => { release = resolve; });
      return snapshot;
    });
    const first = f.t.listConversations();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.records[0].version = 2; f.t.invalidateConversation('0');
    release(); await first;
    const second = await f.t.listConversations();
    expect(second.find((c: any) => c.id === '0').title).toBe('revision 2');
    expect(f.t.mapConversation).toHaveBeenCalledTimes(2);
    expect(f.api.syncAll).toHaveBeenCalledOnce();
  } finally { release?.(); await f.close(); }
});

it('falls back to full recovery after a mapping failure or an SDK stream retry', async () => {
  const f = await setup();
  try {
    f.t.invalidateConversation('0');
    f.t.mapConversation.mockRejectedValueOnce(new Error('local read failed'));
    await expect(f.t.listConversations()).rejects.toThrow('local read failed');
    await f.t.listConversations();
    expect(f.api.syncAll).toHaveBeenCalledTimes(2);
    f.options().onRetry();
    await f.t.listConversations();
    expect(f.api.syncAll).toHaveBeenCalledTimes(3);
  } finally { await f.close(); }
});

it('keeps full reconciliation required when it is requested during an incremental read', async () => {
  const f = await setup(); let release!: () => void;
  try {
    f.t.invalidateConversation('0');
    f.t.mapConversation.mockImplementationOnce(async (record: any) => {
      await new Promise<void>(resolve => { release = resolve; });
      return f.summarize(record);
    });
    const first = f.t.listConversations();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.options().onRestart(); release(); await first;
    await f.t.listConversations();
    expect(f.api.syncAll).toHaveBeenCalledTimes(2);
  } finally { release?.(); await f.close(); }
});

it('updates the cached inbox immediately after local consent and send changes', async () => {
  const f = await setup();
  const record = f.records[0];
  record.consentState = async () => record.consent;
  record.updateConsentState = async (consent: number) => { record.consent = consent; };
  record.sendText = async () => { record.version++; return 'sent'; };
  try {
    await f.t.setConversationConsent('0', 'denied');
    expect((await f.t.listConversations()).find((c: any) => c.id === '0').blocked).toBe(true);
    await f.t.setConversationConsent('0', 'allowed');
    await f.t.send('0', 'hello');
    const changed = (await f.t.listConversations()).find((c: any) => c.id === '0');
    expect(changed).toMatchObject({ blocked: false, title: 'revision 1' });
    expect(f.api.syncAll).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it.each(['focus', 'online', 'visibilitychange'])('forces network reconciliation on %s', async event => {
  const f = await setup();
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
  try {
    f.t.startPoll(f.changed);
    (event === 'visibilitychange' ? doc : win).dispatchEvent(new Event(event));
    await f.t.listConversations();
    expect(f.api.syncAll).toHaveBeenCalledTimes(2);
  } finally { await f.close(); vi.unstubAllGlobals(); }
});

it('reconciles a hidden installation so missed device history requests can be serviced', async () => {
  const f = await setup();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  vi.stubGlobal('document', doc);
  vi.useFakeTimers();
  try {
    f.t.startPoll(f.changed);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(f.changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.changed).toHaveBeenCalledOnce();
    await f.t.listConversations();
    expect(f.api.sync).toHaveBeenCalledTimes(2);
    expect(f.api.syncAll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.changed).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); await f.close(); vi.unstubAllGlobals(); }
});

it('briefly checks requested history every ten seconds, then restores normal polling', async () => {
  const f = await setup();
  f.t.provider = { request: async () => [f.t.myAddress] };
  f.t.client.sendSyncRequest = vi.fn().mockResolvedValue(undefined);
  vi.useFakeTimers();
  try {
    f.t.startPoll(f.changed);
    await f.t.requestHistorySync();
    for (let tick = 1; tick <= 11; tick++) {
      f.changed.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.changed).toHaveBeenCalledOnce();
      await f.t.listConversations();
    }
    f.changed.mockClear();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.changed).toHaveBeenCalledOnce();
    expect(f.t.client.sendSyncRequest).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); await f.close(); }
});

it('refreshes local read counts and reactions without waiting for the next poll', async () => {
  const f = await setup(); const record = f.records[0];
  record.consentState = async () => 1;
  record.sendReaction = async () => { record.version++; };
  Object.assign(f.t.sdk, { ReactionAction: { Added: 'added', Removed: 'removed' }, ReactionSchema: { Unicode: 'unicode' } });
  f.t.client.conversations.getMessageById = async () => ({ id: 'message', conversationId: '0', reactions: [] });
  f.t.senderInboxByMessage.set('message', 'peer');
  f.t.messageCursors.set('message', { conversationId: '0', at: 10n });
  f.t.mapConversation.mockImplementation(async (value: any) => ({ ...f.summarize(value), unread: f.t.readState.get(value.id) < 10n ? 1 : 0 }));
  try {
    f.t.invalidateConversation('0');
    expect((await f.t.listConversations()).find((c: any) => c.id === '0').unread).toBe(1);
    await f.t.markRead('0', { throughMessageId: 'message', sendReceipt: false });
    expect((await f.t.listConversations()).find((c: any) => c.id === '0').unread).toBe(0);
    await f.t.react('0', 'message', '👍');
    expect((await f.t.listConversations()).find((c: any) => c.id === '0').title).toBe('revision 1');
    expect(f.api.syncAll).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('uses fresh SDK wrappers for known metadata and preserves list-based discovery', async () => {
  const f = await setup();
  try {
    const replacement = { ...f.records[0], version: 2, consent: 2 };
    f.records[0] = replacement;
    f.t.invalidateConversation('0');
    const result = await f.t.listConversations();
    expect(f.api.list).toHaveBeenCalledOnce(); expect(f.api.getConversationById).toHaveBeenCalledOnce();
    expect(f.t.conversations.get('0')).toBe(replacement);
    expect(result.find((c: any) => c.id === '0')).toMatchObject({ title: 'revision 2', blocked: true });
    f.records.push({ id: 'new', version: 3, consent: 1 }); f.t.invalidateConversation('new');
    expect((await f.t.listConversations()).find((c: any) => c.id === 'new')).toMatchObject({ title: 'revision 3' });
    expect(f.api.list).toHaveBeenCalledTimes(2); expect(f.api.getConversationById).toHaveBeenCalledOnce();
    expect(f.api.syncAll).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
it('falls back to local enumeration for missing IDs and removes only records absent from that list', async () => {
  const f = await setup();
  try {
    f.records.shift(); f.t.invalidateConversation('0');
    const result = await f.t.listConversations();
    expect(result.map((c: any) => c.id)).toEqual(['1', '2']);
    expect(f.api.list).toHaveBeenCalledTimes(2); expect(f.api.syncAll).toHaveBeenCalledOnce();
    f.api.getConversationById.mockResolvedValueOnce(undefined);
    f.records[0] = { ...f.records[0], version: 8 }; f.t.invalidateConversation('1');
    expect((await f.t.listConversations()).find((c: any) => c.id === '1').title).toBe('revision 8');
    expect(f.api.list).toHaveBeenCalledTimes(3);
  } finally { await f.close(); }
});
it('retains summaries on a lookup failure and forces full recovery on the next refresh', async () => {
  const f = await setup();
  try {
    const previous = f.t.mappedConversations;
    f.api.getConversationById.mockRejectedValueOnce(new Error('local lookup unavailable'));
    f.t.invalidateConversation('0');
    await expect(f.t.listConversations()).rejects.toThrow('local lookup unavailable');
    expect(f.t.mappedConversations).toBe(previous); expect(f.t.fullRefreshRequired).toBe(true);
    expect(f.t.dirtyConversations.has('0')).toBe(true);
    await f.t.listConversations(); expect(f.api.syncAll).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});
it('rejects a mismatched lookup without replacing cached conversations', async () => {
  const f = await setup();
  try {
    const previous = f.t.conversations.get('0');
    f.api.getConversationById.mockResolvedValueOnce({ id: 'foreign', version: 7 } as any);
    f.t.invalidateConversation('0');
    await expect(f.t.listConversations()).rejects.toThrow('different conversation');
    expect(f.t.conversations.get('0')).toBe(previous); expect(f.t.conversations.has('foreign')).toBe(false);
    expect(f.t.mapConversation).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
it('bounds targeted reads to eight in flight and enumerates once for larger invalidation bursts', async () => {
  const f = await setup(101); let release!: () => void;
  try {
    let active = 0, maximum = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.api.getConversationById.mockImplementation(async id => {
      active++; maximum = Math.max(maximum, active); await held; active--;
      return f.records.find(record => record.id === id);
    });
    for (let index = 0; index < 100; index++) f.t.invalidateConversation(String(index));
    const pending = f.t.listConversations();
    await vi.waitFor(() => expect(f.api.getConversationById).toHaveBeenCalledTimes(8));
    release(); await pending;
    expect(maximum).toBe(8); expect(f.api.getConversationById).toHaveBeenCalledTimes(100); expect(f.api.list).toHaveBeenCalledOnce();
    for (let index = 0; index < 101; index++) f.t.invalidateConversation(String(index));
    await f.t.listConversations();
    expect(f.api.getConversationById).toHaveBeenCalledTimes(100); expect(f.api.list).toHaveBeenCalledTimes(2);
    expect(f.api.syncAll).toHaveBeenCalledOnce();
  } finally { release?.(); await f.close(); }
});
it('keeps new invalidations arriving during targeted lookup for the next refresh', async () => {
  const f = await setup(); let release!: () => void;
  try {
    f.api.getConversationById.mockImplementationOnce(async id => {
      const value = { ...f.records.find(record => record.id === id) };
      await new Promise<void>(resolve => { release = resolve; }); return value;
    });
    f.t.invalidateConversation('0'); const first = f.t.listConversations();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.records[0].version = 5; f.t.invalidateConversation('0'); release();
    expect((await first).find((c: any) => c.id === '0').title).toBe('revision 0');
    expect((await f.t.listConversations()).find((c: any) => c.id === '0').title).toBe('revision 5');
    expect(f.api.list).toHaveBeenCalledOnce(); expect(f.api.getConversationById).toHaveBeenCalledTimes(2);
  } finally { release?.(); await f.close(); }
});

it('applies fresh room restrictions and namespace changes through the real room mapper', async () => {
  const f = await setup();
  try {
    const room = { isPendingRemoval: vi.fn().mockResolvedValue(false), isActive: vi.fn().mockResolvedValue(true), consentState: vi.fn().mockResolvedValue(1), id: 'room', name: 'Original title', metadata: { conversationType: 'group' },
      description: JSON.stringify({ chirpyRoom: 1, namespace: 'personal', policy: { mode: 'active' } }),
      lastMessage: async () => undefined, members: async () => [], countMessages: async () => 0n,
      isAdmin: async () => false, isSuperAdmin: async () => false, sendText: vi.fn() };
    f.records.push(room); f.t.invalidateConversation('room');
    f.t.mapConversation.mockImplementation((record: any) => record.id === 'room'
      ? (XmtpTransport.prototype as any).mapRoomConversation.call(f.t, record) : f.summarize(record));
    f.t.unreadCount = async () => 0; f.t.addressesForMembers = async () => [];
    expect((await f.t.listConversations()).find((c: any) => c.id === 'room').policy.mode).toBe('active');
    f.records[f.records.length - 1] = { ...room, name: 'Changed title',
      description: JSON.stringify({ chirpyRoom: 1, namespace: 'personal', policy: { mode: 'read-only' } }) };
    f.t.invalidateConversation('room');
    expect((await f.t.listConversations()).find((c: any) => c.id === 'room')).toMatchObject({ title: 'Changed title', policy: { mode: 'read-only' } });
    f.t.assertConversationAccepted = vi.fn(); f.t.assertGateAllows = vi.fn();
    await expect(f.t.send('room', 'must stay blocked')).rejects.toThrow('read-only'); expect(room.sendText).not.toHaveBeenCalled();
    f.records[f.records.length - 1] = { ...room,
      description: JSON.stringify({ chirpyRoom: 1, namespace: 'other', policy: { mode: 'read-only' } }) };
    f.t.invalidateConversation('room');
    expect((await f.t.listConversations()).some((c: any) => c.id === 'room')).toBe(false);
    expect(f.api.list).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

it('does not postpone full reconciliation and prunes unrelated silent removals on that pass', async () => {
  const f = await setup(); const completed = f.t.fullRefreshCompletedAt;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(completed + 30_000);
  try {
    f.records.pop(); f.t.invalidateConversation('0');
    expect((await f.t.listConversations()).some((c: any) => c.id === '2')).toBe(true);
    expect(f.t.fullRefreshCompletedAt).toBe(completed);
    f.t.fullRefreshRequired = true;
    expect((await f.t.listConversations()).some((c: any) => c.id === '2')).toBe(false);
    expect(f.api.syncAll).toHaveBeenCalledTimes(2); expect(f.api.list).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); await f.close(); }
});

it('does not add an unlisted or duplicate DM through a direct lookup of an unknown ID', async () => {
  const f = await setup();
  try {
    f.api.getConversationById.mockResolvedValue({ id: 'unlisted-duplicate', version: 1 } as any);
    f.t.invalidateConversation('unlisted-duplicate');
    const result = await f.t.listConversations();
    expect(result.map((c: any) => c.id)).toEqual(['0', '1', '2']);
    expect(f.api.getConversationById).not.toHaveBeenCalled(); expect(f.api.list).toHaveBeenCalledTimes(2);
    expect(f.t.conversations.has('unlisted-duplicate')).toBe(false);
  } finally { await f.close(); }
});


it('refreshes SDK consent changes without a new message and drains the consent stream on teardown', async () => {
  const f = await setup();
  f.records[0].consent = 2; f.consentStream.push([{ entity: '0', state: 2 }]);
  await vi.waitFor(() => expect(f.changed).toHaveBeenCalled());
  expect((await f.t.listConversations()).find(c => c.id === '0').blocked).toBe(true);
  f.records[0].consent = 1; f.consentStream.push([{ entity: '0', state: 1 }]);
  await vi.waitFor(() => expect(f.t.fullRefreshRequired).toBe(true));
  expect((await f.t.listConversations()).find(c => c.id === '0').blocked).toBe(false);
  await f.close(); expect(f.t.consentTask).toBeNull();
  const calls = f.changed.mock.calls.length; f.consentStream.push([{ entity: '0', state: 2 }]);
  await Promise.resolve(); expect(f.changed).toHaveBeenCalledTimes(calls);
});

it('does not publish stale consent held by a slow directory read after another device blocks', async () => {
  const f = await setup(); let release!: (value: unknown[]) => void;
  try {
    f.t.fullRefreshRequired = true;
    f.t.publishedRooms.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const refresh = f.t.listConversations();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.records[0].consent = 2;
    f.consentStream.push([{ entity: '0', state: 2 }]);
    await vi.waitFor(() => expect(f.t.fullRefreshRequired).toBe(true));
    release([]);
    expect((await refresh).find(c => c.id === '0').blocked).toBe(true);
  } finally { release?.([]); await f.close(); }
});


it('closes a consent stream that finishes opening after unsubscribe without publishing its result', async () => {
  let release!: (stream: any) => void;
  const f = await setup(3, () => new Promise(resolve => { release = resolve; }));
  const late = source(); const close = vi.spyOn(late, 'return');
  await f.close(); f.changed.mockClear();
  release(late);
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  late.push([{ entity: '0', state: 2 }]);
  await Promise.resolve();
  expect(f.changed).not.toHaveBeenCalled();
  expect(f.t.consentTask).toBeNull();
  expect(f.t.consentStreamHealthy).toBe(false);
});

it('replaces a previous client consent stream and ignores late callbacks from that session', async () => {
  const f = await setup();
  const previousOptions = f.t.client.preferences.streamConsent.mock.calls[0][0];
  const closePrevious = vi.spyOn(f.consentStream, 'return');
  const next = source();
  const api = vi.fn(async () => next);
  f.t.client = { ...f.t.client, preferences: { streamConsent: api } };
  try {
    f.t.startConsentStream(f.changed);
    await vi.waitFor(() => expect(api).toHaveBeenCalledOnce());
    expect(closePrevious).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.t.consentStreamHealthy).toBe(true));
    f.changed.mockClear(); f.t.fullRefreshRequired = false;
    previousOptions.onError(); previousOptions.onRestart();
    f.consentStream.push([{ entity: '0', state: 2 }]);
    await Promise.resolve();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.t.fullRefreshRequired).toBe(false);
    expect(f.t.consentStreamHealthy).toBe(true);
    next.push([{ entity: '0', state: 2 }]);
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledOnce());
  } finally { await f.close(); }
});

it('reopens a terminated consent stream while keeping fallback reconciliation active', async () => {
  const f = await setup();
  const next = source();
  const api = f.t.client.preferences.streamConsent;
  api.mockResolvedValueOnce(next);
  try {
    await f.consentStream.return();
    await vi.waitFor(() => expect(f.t.consentStreamHealthy).toBe(false));
    expect(f.t.fullRefreshRequired).toBe(true);
    f.t.startConsentStream(f.changed);
    expect(api).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await vi.waitFor(() => expect(f.t.consentStreamHealthy).toBe(true));
    f.changed.mockClear(); next.push([{ entity: '0', state: 2 }]);
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledOnce());
  } finally { await f.close(); }
});
