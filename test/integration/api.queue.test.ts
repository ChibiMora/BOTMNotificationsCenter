// API composition root wiring (§6.3, §8.1): QUEUE_IMPL=db gives a queue whose enqueue inserts a job row.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { RecordingMetrics } from '../helpers/deps.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { selectQueue } from '../../src/api.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

describe('api queue wiring', () => {
  it('QUEUE_IMPL=db: enqueue inserts a queued job row', async () => {
    const config = { ...testConfig(), queueImpl: 'db' } as ReturnType<typeof testConfig>;
    const parts = {
      db,
      clock: new FixedClock(),
      log: createLogger('silent'),
      metrics: new RecordingMetrics(),
    };
    const queue = selectQueue(config, parts);
    await queue.enqueue('cancel_scheduled', { notificationId: 7 } as never);
    const rows = await db('jobs').select('type', 'status', 'attempts');
    expect(rows).toEqual([{ type: 'cancel_scheduled', status: 'queued', attempts: 0 }]);
  });
});
