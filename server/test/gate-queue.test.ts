import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateWorkQueue, GateQueueBusyError } from '../gate-queue.js';
afterEach(() => vi.useRealTimers());
describe('gate work backpressure', () => {
  it('bounds pending work and preserves serial execution after a failure', async () => {
    const queue = createGateWorkQueue({ maxPending: 1 });
    let release!: () => void;
    const first = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const next = vi.fn(async () => { throw new Error('failed'); });
    const second = queue.run(next);
    const rejected = expect(second).rejects.toThrow('failed');
    await expect(queue.run(async () => {})).rejects.toBeInstanceOf(GateQueueBusyError);
    expect(next).not.toHaveBeenCalled();
    expect(queue.status()).toMatchObject({ active: true, pending: 1 });
    release(); await first; await rejected;
    expect(await queue.run(async () => 'recovered')).toBe('recovered');
  });
  it('expires waiting work without releasing an active native operation', async () => {
    vi.useFakeTimers();
    const queue = createGateWorkQueue({ maxPending: 2, maxWaitMs: 100 });
    let release!: () => void;
    const active = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
    const work = vi.fn();
    const expired = expect(queue.run(work)).rejects.toBeInstanceOf(GateQueueBusyError);
    await vi.advanceTimersByTimeAsync(101); await expired;
    expect(work).not.toHaveBeenCalled();
    expect(queue.status()).toMatchObject({ active: true, pending: 0 });
    const later = vi.fn(async () => 'later'); const waiting = queue.run(later);
    await Promise.resolve(); expect(later).not.toHaveBeenCalled();
    release(); await active; expect(await waiting).toBe('later');
  });
  it.each([{ maxPending: 0 }, { maxPending: 129 }, { maxWaitMs: Infinity }, { maxWaitMs: 0 }])('rejects unsafe limits: %j', options => {
    expect(() => createGateWorkQueue(options)).toThrow('limits');
  });
});
