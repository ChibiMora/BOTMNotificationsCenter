// Worker composition root (§6, §8): stub registries start/stop cleanly; stub jobs end dead, never dropped.
import http from 'node:http';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { DbQueue } from '../../src/queue/dbQueue.js';
import { jobHandlers } from '../../src/jobs/index.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

describe('worker', () => {
  it('importing worker.ts starts nothing', async () => {
    const spy = vi.spyOn(http, 'createServer');
    const mod = await import('../../src/worker.js');
    expect(typeof mod.startWorker).toBe('function');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('the registry lists all five job types', () => {
    const deps = makeTestDeps({ db });
    expect(Object.keys(jobHandlers(deps)).sort()).toEqual([
      'account_recheck',
      'cancel_scheduled',
      'event_delivery',
      'fanout_filter',
      'process_import',
    ]);
  });

  it('startWorker starts and stops cleanly; a stub-handler job ends dead after max attempts', async () => {
    const config = { ...testConfig(), queueImpl: 'db' } as ReturnType<typeof testConfig>;
    const clock = new FixedClock();
    const metrics = new RecordingMetrics();
    const queue = new DbQueue(config, { db, clock, log: createLogger('silent'), metrics, manual: true });
    const deps = makeTestDeps({ db, config, clock, queue, metrics });
    const { startWorker } = await import('../../src/worker.js');
    const w = await startWorker(deps, { scheduler: false });
    await queue.enqueue('event_delivery', {
      type: 'shipped',
      accountId: 1,
      occurredAt: '2026-10-01T00:00:00Z',
      occurrenceKey: 'k',
    });
    for (let i = 0; i < config.jobMaxAttempts; i++) {
      expect(await queue.runOnce()).toBe(1);
      clock.advance(2 ** (i + 1) * 60_000);
    }
    const row = await db('jobs').first('status', 'attempts', 'last_error');
    expect(row).toMatchObject({ status: 'dead', attempts: config.jobMaxAttempts });
    expect(row.last_error).toMatch(/event_delivery handler not implemented/);
    expect(metrics.calls.filter((c) => c.name === 'job_dead')).toHaveLength(1);
    await w.stop();
  });
});
