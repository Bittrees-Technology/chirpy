import { expect, it } from 'vitest';
import { mapConversations } from '../src/mapConversations';
it('bounds SDK work for 10,000 conversations while retaining order', async () => {
  const values = Array.from({ length: 10_000 }, (_, index) => index);
  let active = 0; let maximum = 0;
  const result = await mapConversations(values, async value => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return value * 2;
  });
  expect(result).toEqual(values.map(value => value * 2));
  expect(maximum).toBe(8); expect(active).toBe(0);
});
it('stops starting work after a failure and drains active reads before retry', async () => {
  let started = 0; let active = 0;
  await expect(mapConversations(Array.from({ length: 100 }, (_, index) => index), async value => {
    started++; active++;
    try { if (value === 0) throw new Error('offline'); await new Promise(resolve => setImmediate(resolve)); return value; }
    finally { active--; }
  })).rejects.toThrow('offline');
  expect(started).toBe(8); expect(active).toBe(0);
  expect(await mapConversations([1, 2], async value => value)).toEqual([1, 2]);
  expect(await mapConversations([], async value => value)).toEqual([]);
});
