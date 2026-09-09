export class GateQueueBusyError extends Error {
  constructor() { super('Gate work queue is busy.'); this.name = 'GateQueueBusyError'; }
}

// Never release the active slot on a timeout: a native write could still be running.
// Only queued work expires. One process owns the database and shares this queue.
export function createGateWorkQueue({ maxPending = 32, maxWaitMs = 10_000 } = {}) {
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 128 || !Number.isInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 60_000) throw new Error('Invalid gate queue limits.');
  let active = false;
  const pending = [];
  function drain() {
    if (active || !pending.length) return;
    const job = pending.shift();
    clearTimeout(job.timer);
    active = true;
    Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { active = false; drain(); });
  }
  return {
    status: () => ({ active, pending: pending.length, capacity: maxPending }),
    run(work) {
      if (pending.length >= maxPending) return Promise.reject(new GateQueueBusyError());
      return new Promise((resolve, reject) => {
        const job = { work, resolve, reject, timer: undefined };
        job.timer = setTimeout(() => {
          const index = pending.indexOf(job);
          if (index >= 0) { pending.splice(index, 1); reject(new GateQueueBusyError()); }
        }, maxWaitMs);
        pending.push(job); drain();
      });
    },
  };
}
export const gateWorkQueue = createGateWorkQueue();
