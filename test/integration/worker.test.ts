// Worker composition root (§6, §8): registries are complete; failing jobs end dead, never dropped. Independent of
// what the registry's handlers and timers do (later units replace them): behaviour tests inject their own.
import http from 'node:http';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { DbQueue } from '../../src/queue/dbQueue.js';
import { jobHandlers } from '../../src/jobs/index.js';
import { timers } from '../../src/scheduler/index.js';
import type { JobHandlers } from '../../src/queue/queue.js';

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

  it('the default registries are complete: five job handlers, four timers with valid schedules', () => {
    const deps = makeTestDeps({ db });
    const h = jobHandlers(deps);
    expect(Object.keys(h).sort()).toEqual([
      'account_recheck',
      'cancel_scheduled',
      'event_delivery',
      'fanout_filter',
      'process_import',
    ]);
    for (const fn of Object.values(h)) expect(typeof fn).toBe('function');
    const list = timers(deps);
    expect(list.map((t) => [t.name, t.leaderOnly]).sort()).toEqual([
      ['due_send', false],
      ['expiry', true],
      ['housekeeping', true],
      ['rescan', true],
    ]);
    for (const t of list) {
      expect(typeof t.run).toBe('function');
      expect(typeof t.schedule.isDue(new Date('2026-10-04T00:00:00Z'), undefined)).toBe('boolean');
    }
  });

  it('startWorker uses an injected timer list instead of the default registry', async () => {
    const base = makeTestDeps({ db });
    const deps = { ...base, config: { ...base.config, housekeepingCron: '1-5/x * * * *' } };
    const { startWorker } = await import('../../src/worker.js');
    const w = await startWorker(deps, { timers: [] });
    await w.stop();
  });

  it('startWorker starts and stops cleanly; a job whose handler always throws ends dead after max attempts', async () => {
    const config = { ...testConfig(), queueImpl: 'db' } as ReturnType<typeof testConfig>;
    const clock = new FixedClock();
    const metrics = new RecordingMetrics();
    const queue = new DbQueue(config, { db, clock, log: createLogger('silent'), metrics, manual: true });
    const deps = makeTestDeps({ db, config, clock, queue, metrics });
    const { startWorker } = await import('../../src/worker.js');
    const fail = async () => {
      throw new Error('injected handler failure');
    };
    const handlers: JobHandlers = {
      event_delivery: fail,
      fanout_filter: fail,
      process_import: fail,
      cancel_scheduled: fail,
      account_recheck: fail,
    };
    const w = await startWorker(deps, { scheduler: false, handlers });
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
    expect(row.last_error).toMatch(/injected handler failure/);
    expect(metrics.calls.filter((c) => c.name === 'job_dead')).toHaveLength(1);
    await w.stop();
  });
});
