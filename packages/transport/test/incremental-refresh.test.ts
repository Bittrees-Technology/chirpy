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
    return() { closed = true; waiting?.({ value: undefined, done: true }); waiting = undefined; },
  };
}
async function setup(count = 3) {
  const t = new XmtpTransport(PERSONAL_ORG, { address: '0x0000000000000000000000000000000000000001' }, null) as any;
  const records: any[] = Array.from({ length: count }, (_, i) => ({ id: String(i), version: 0, consent: 1, metadata: { conversationType: 'dm' } }));
  const stream = source();
  let options: any;
  const api = { sync: vi.fn(), syncAll: vi.fn(), list: vi.fn(async () => [...records]),
    getConversationById: vi.fn(async (id: string) => records.find(record => record.id === id)),
    streamAllMessages: vi.fn(async (value: any) => { options = value; return stream; }) };
  t.client = { conversations: api, inboxId: 'self' }; t.status = 'ready';
  t.sdk = { ConversationType: { Group: 'group' }, ConsentState: { Allowed: 1, Denied: 2 } };
  const summarize = (record: any) => ({ id: record.id, kind: 'dm', title: `revision ${record.version}`, peers: [], unread: 0, blocked: record.consent === 2 });
  t.mapConversation = vi.fn(async (record: any) => summarize(record));
  t.publishedRooms = vi.fn().mockResolvedValue([]);
  const changed = vi.fn();
  const stop = t.subscribe(changed);
  await vi.waitFor(() => expect(api.streamAllMessages).toHaveBeenCalledOnce());
  await t.listConversations();
  t.mapConversation.mockClear(); changed.mockClear();
  return { t, records, stream, api, changed, summarize, options: () => options,
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
