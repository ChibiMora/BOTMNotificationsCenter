// §11.4 job outcomes, queue depth/oldest age, scheduled-run health (U10).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { DbQueue } from '../../src/queue/dbQueue.js';
import { createScheduler } from '../../src/scheduler/index.js';
import { intervalSchedule } from '../../src/scheduler/schedule.js';
import { createQueue } from '../../src/queue/index.js';

const db = testDb();
const config = { ...testConfig(), queueImpl: 'db', jobMaxAttempts: 2 } as ReturnType<typeof testConfig>;
let clock: FixedClock;
let metrics: RecordingMetrics;
beforeEach(async () => {
  await resetDb(db);
  clock = new FixedClock(new Date('2026-10-04T14:30:00Z'));
  metrics = new RecordingMetrics();
});
afterAll(() => db.destroy());

const queue = () =>
  createQueue(config, {
    db,
    clock,
    log: createLogger('silent'),
    metrics,
    workerId: 'w1',
    manual: true,
  } as any) as DbQueue;
const named = (n: string) => metrics.calls.filter((c) => c.name === n);

describe('job metrics', () => {
  it('job_outcome by type and outcome; job_duration_ms by type', async () => {
    const q = queue();
    let fail = true;
    const h = async () => {
      if (fail) throw new Error('x');
    };
    await q.consume({ account_recheck: h, cancel_scheduled: h } as any, { onDead: async () => {} } as any);
    await q.enqueue('account_recheck', { accountId: 1, requestId: 'r' });
    await q.runOnce();
    expect(named('job_outcome')).toEqual([
      { kind: 'count', name: 'job_outcome', value: 1, dims: { type: 'account_recheck', outcome: 'retry' } },
    ]);
    fail = false;
    clock.advance(10 * 60_000);
    await q.runOnce();
    expect(named('job_outcome')[1]?.dims).toEqual({ type: 'account_recheck', outcome: 'done' });
    expect(named('job_duration_ms').map((c) => c.dims)).toEqual([
      { type: 'account_recheck' },
      { type: 'account_recheck' },
    ]);
  });

  it('upkeep gauges queue_depth (due queued jobs) and queue_oldest_age_seconds', async () => {
    const q = queue();
    await q.enqueue('cancel_scheduled', { notificationId: 1 });
    clock.advance(90_000);
    await q.enqueue('cancel_scheduled', { notificationId: 2 });
    await q.enqueue(
      'cancel_scheduled',
      { notificationId: 3 },
      { runAt: new Date(clock.now().getTime() + 3_600_000) },
    );
    await q.upkeep();
    expect(named('queue_depth')).toEqual([{ kind: 'gauge', name: 'queue_depth', value: 2, dims: undefined }]);
    expect(named('queue_oldest_age_seconds')).toEqual([
      { kind: 'gauge', name: 'queue_oldest_age_seconds', value: 90, dims: undefined },
    ]);
  });

  it('scheduled_run counts ok, failed and skipped by name', async () => {
    const deps = makeTestDeps({ db, clock, metrics });
    const every = intervalSchedule(60);
    let release!: () => void;
    const s = createScheduler(
      deps,
      [
        { name: 'rescan', leaderOnly: false, schedule: every, run: async () => {} },
        {
          name: 'due_send',
          leaderOnly: false,
          schedule: every,
          run: async () => Promise.reject(new Error('x')),
        },
        {
          name: 'expiry',
          leaderOnly: false,
          schedule: every,
          run: () => new Promise<void>((r) => (release = r)),
        },
      ],
      { isLeader: () => true },
    );
    const first = s.tick(clock.now());
    await new Promise((r) => setTimeout(r, 50));
    clock.advance(61_000);
    await s.tick(clock.now());
    release();
    await first;
    const runs = named('scheduled_run').map((c) => `${c.dims?.name}:${c.dims?.status}`);
    expect(runs).toEqual(
      expect.arrayContaining(['rescan:ok', 'due_send:failed', 'expiry:skipped', 'expiry:ok']),
    );
  });
});
