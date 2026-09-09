import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMembershipWorker } from '../gate-membership-worker.js';
afterEach(() => vi.useRealTimers());
describe('membership maintenance scheduling', () => {
  it('does nothing unless explicitly enabled', async () => {
    vi.useFakeTimers(); const getClient = vi.fn();
    const stop = startMembershipWorker({ env: {}, getClient });
    await vi.advanceTimersByTimeAsync(120000); expect(getClient).not.toHaveBeenCalled(); stop();
    expect(() => startMembershipWorker({ env: { GATE_MEMBERSHIP_MODE: 'invalid' } })).toThrow();
  });
  it('bounds each pass and advances through a room without overlapping passes', async () => {
    vi.useFakeTimers();
    const identifiers = Array.from({ length: 60 }, (_, index) => ({ inboxId: `member-${index}`, accountIdentifiers: [] }));
    const group = { sync: vi.fn(), members: vi.fn(async () => identifiers), removeMembers: vi.fn(), isAdmin: () => false, isSuperAdmin: () => true };
    const bot = { inboxId: 'bot', conversations: { sync: vi.fn(), getConversationById: vi.fn(async () => group) } };
    const report = vi.fn();
    const stop = startMembershipWorker({ env: { GATE_MEMBERSHIP_MODE: 'audit' }, getClient: async () => bot,
      getRooms: async () => [{ id: 'room', gate: { combine: 'all', rules: [] } }], report });
    await vi.advanceTimersByTimeAsync(5001);
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ checked: 25, removed: 0 }));
    await vi.advanceTimersByTimeAsync(60001);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ checked: 25 }));
    stop(); await vi.advanceTimersByTimeAsync(120000); expect(report).toHaveBeenCalledTimes(2);
    expect(group.removeMembers).not.toHaveBeenCalled();
  });
  it('does not start another pass while SDK initialization is pending', async () => {
    vi.useFakeTimers(); let finish!: (value: any) => void;
    const getClient = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const report = vi.fn();
    const stop = startMembershipWorker({ env: { GATE_MEMBERSHIP_MODE: 'audit' }, getClient, getRooms: async () => [{ id: 'room' }], report });
    await vi.advanceTimersByTimeAsync(180000); expect(getClient).toHaveBeenCalledTimes(1);
    stop(); finish({ conversations: { sync: async () => {}, getConversationById: async () => undefined } });
    await vi.advanceTimersByTimeAsync(1); expect(report).toHaveBeenCalledTimes(1);
  });
});
