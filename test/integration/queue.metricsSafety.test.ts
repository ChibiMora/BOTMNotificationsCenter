// A throwing metrics sink never fails a job attempt or the upkeep pass of the stand-in queue (§9 metrics, §11).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { DbQueue } from '../../src/queue/dbQueue.js';
import type { Metrics } from '../../src/lib/metrics.js';
import type { JobHandlers } from '../../src/queue/queue.js';

const db = testDb();
const config = { ...testConfig(), queueImpl: 'db', jobMaxAttempts: 3 } as ReturnType<typeof testConfig>;
const throwing: Metrics = {
  count: () => {
    throw new Error('sink down');
  },
  gauge: () => {
    throw new Error('sink down');
  },
  timing: () => {
    throw new Error('sink down');
  },
} as unknown as Metrics;

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

describe('stand-in queue with a throwing metrics sink', () => {
  it('runs the job to done and upkeep resolves', async () => {
    const clock = new FixedClock(new Date('2026-10-04T14:30:00Z'));
    const q = new DbQueue(config, {
      db,
      clock,
      log: createLogger('silent'),
      metrics: throwing,
      workerId: 'w1',
      manual: true,
    });
    let ran = 0;
    const handlers = { cancel_scheduled: async () => void ran++ } as unknown as JobHandlers;
    const consumer = await q.consume(handlers, { onDead: async () => undefined } as never);
    await q.enqueue('cancel_scheduled', { notificationId: 1 });
    await expect(q.runOnce()).resolves.toBe(1);
    await expect(q.upkeep()).resolves.toBeUndefined();
    await consumer.stop();
    expect(ran).toBe(1);
    expect(await db('jobs').pluck('status')).toEqual(['done']);
  });
});
