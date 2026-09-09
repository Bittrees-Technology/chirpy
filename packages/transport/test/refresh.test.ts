import { afterEach, expect, it, vi } from 'vitest';
import { XmtpTransport } from '../src/xmtp';
import { PERSONAL_ORG } from '@app/core';
const make = () => new XmtpTransport(PERSONAL_ORG, { address: '0x0000000000000000000000000000000000000001' }, null) as any;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('shares concurrent inbox refreshes and permits a later retry after failure', async () => {
  const t = make(); t.status = 'ready';
  let finish!: () => void;
  const sync = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const list = vi.fn().mockResolvedValue([]);
  t.client = { conversations: { sync, syncAll: vi.fn(), list } };
  const first = t.listConversations(); const second = t.listConversations();
  expect(first).toBe(second); expect(sync).toHaveBeenCalledTimes(1);
  finish(); await first; expect(list).toHaveBeenCalledTimes(1);
  sync.mockRejectedValueOnce(new Error('offline'));
  await expect(t.listConversations()).rejects.toThrow();
  sync.mockResolvedValue(undefined); await t.listConversations();
  expect(sync).toHaveBeenCalledTimes(3);
});
it('polling notifies once without fetching twice and pauses while hidden', async () => {
  vi.useFakeTimers(); const t = make(); t.status = 'ready';
  t.listConversations = vi.fn(); t.runStream = vi.fn();
  const cb = vi.fn(); const doc = { visibilityState: 'visible' };
  vi.stubGlobal('document', doc); t.startPoll(cb);
  await vi.advanceTimersByTimeAsync(10000); expect(cb).toHaveBeenCalledTimes(1);
  expect(t.listConversations).not.toHaveBeenCalled();
  doc.visibilityState = 'hidden'; await vi.advanceTimersByTimeAsync(30000);
  expect(cb).toHaveBeenCalledTimes(1); clearInterval(t.pollTimer);
});
