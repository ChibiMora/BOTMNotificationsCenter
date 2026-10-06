// Housekeeping (§8.3 row): one test per bullet, against the real database and FakeQueue.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { DbQueue } from '../../src/queue/dbQueue.js';
import { makeNotification, makeDelivery, makeImport } from '../helpers/factories.js';
import { FakeQueue } from '../helpers/fakeQueue.js';
import { housekeeping } from '../../src/scheduler/housekeeping.js';
import { monthKey } from '../../src/lib/time.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
const DAY = 86_400_000;

describe('housekeeping', () => {
  it('enqueues fanout_filter only for active filter notifications with no delivery this month', async () => {
    const deps = makeTestDeps({ db });
    const now = deps.clock.now();
    const orphan = await makeNotification(db, 'filter', { active: true });
    const covered = await makeNotification(db, 'filter', { active: true });
    await makeDelivery(db, { notification_id: covered.id, account_id: 1, dedupe_key: monthKey(now) });
    await makeNotification(db, 'filter', { active: true, removed: true });
    await makeNotification(db, 'filter', { active: false });
    await makeNotification(db, 'event', { active: true });
    const lastMonthOnly = await makeNotification(db, 'filter', { active: true });
    await makeDelivery(db, {
      notification_id: lastMonthOnly.id,
      account_id: 1,
      dedupe_key: monthKey(new Date(now.getTime() - 40 * DAY)),
    });
    await housekeeping(deps);
    const q = deps.queue as FakeQueue;
    expect(q.enqueued.filter((e) => e.type === 'fanout_filter').map((e) => e.payload)).toEqual([
      { notificationId: orphan.id },
      { notificationId: lastMonthOnly.id },
    ]);
  });

  it('deletes cancelled scheduled deliveries; keeps live and non-cancelled scheduled rows', async () => {
    const deps = makeTestDeps({ db });
    const now = deps.clock.now();
    const gone = await makeNotification(db, 'event', { active: false });
    const live = await makeNotification(db, 'event', { active: true });
    await makeDelivery(db, {
      notification_id: gone.id,
      account_id: 1,
      sent_at: null,
      due_at: now,
      dedupe_key: 'a',
    });
    const sent = await makeDelivery(db, {
      notification_id: gone.id,
      account_id: 1,
      sent_at: now,
      dedupe_key: 'b',
    });
    const sched = await makeDelivery(db, {
      notification_id: live.id,
      account_id: 1,
      sent_at: null,
      due_at: now,
      dedupe_key: 'c',
    });
    await housekeeping(deps);
    expect(await db('notification_deliveries').orderBy('id').pluck('id')).toEqual([sent.id, sched.id]);
  });

  it('re-enqueues the latest run of a stale processing import; leaves a fresh one alone', async () => {
    const deps = makeTestDeps({ db });
    const now = deps.clock.now();
    const n = await makeNotification(db, 'csv');
    const stale = await makeImport(db, {
      notification_id: n.id,
      status: 'processing',
      updated_at: new Date(now.getTime() - 11 * 60_000),
    });
    const fresh = await makeImport(db, { notification_id: n.id, status: 'processing', updated_at: now });
    await db('import_runs').insert({ import_id: stale.id, status: 'failed', started_at: now });
    const [latest] = await db('import_runs').insert({
      import_id: stale.id,
      status: 'processing',
      started_at: now,
    });
    await db('import_runs').insert({ import_id: fresh.id, status: 'processing', started_at: now });
    await housekeeping(deps);
    const q = deps.queue as FakeQueue;
    expect(q.enqueued.filter((e) => e.type === 'process_import').map((e) => e.payload)).toEqual([
      { importId: stale.id, runId: latest },
    ]);
  });

  it('deletes import_files of imports failed more than 30 days ago only', async () => {
    const deps = makeTestDeps({ db });
    const now = deps.clock.now();
    const n = await makeNotification(db, 'csv');
    const old = await makeImport(db, {
      notification_id: n.id,
      status: 'failed',
      updated_at: new Date(now.getTime() - 31 * DAY),
    });
    const recent = await makeImport(db, {
      notification_id: n.id,
      status: 'failed',
      updated_at: new Date(now.getTime() - 29 * DAY),
    });
    const oldDone = await makeImport(db, {
      notification_id: n.id,
      status: 'completed',
      updated_at: new Date(now.getTime() - 31 * DAY),
    });
    await db('import_files').insert([
      { import_id: old.id, data: Buffer.from('x') },
      { import_id: recent.id, data: Buffer.from('y') },
      { import_id: oldDone.id, data: Buffer.from('z') },
    ]);
    await housekeeping(deps);
    expect(await db('import_files').orderBy('import_id').pluck('import_id')).toEqual([recent.id, oldDone.id]);
  });

  it('purges dead jobs older than DEAD_JOB_RETENTION_DAYS through the queue (DbQueue)', async () => {
    const clock = new FixedClock();
    const config = { ...testConfig(), queueImpl: 'db', jobMaxAttempts: 1 } as ReturnType<typeof testConfig>;
    const queue = new DbQueue(config, {
      db,
      clock,
      log: createLogger('silent'),
      metrics: new RecordingMetrics(),
      manual: true,
    });
    const deps = makeTestDeps({ db, config, clock, queue });
    const fail = async () => {
      throw new Error('boom');
    };
    const consumer = await queue.consume(
      Object.fromEntries(
        ['fanout_filter', 'process_import', 'event_delivery', 'account_recheck', 'cancel_scheduled'].map(
          (t) => [t, fail],
        ),
      ) as never,
      { onDead: async () => {} },
    );
    await queue.enqueue('event_delivery', { n: 'old' } as never);
    await queue.runOnce();
    clock.advance(2 * DAY);
    await queue.enqueue('event_delivery', { n: 'recent' } as never);
    await queue.runOnce();
    clock.advance((config.deadJobRetentionDays - 1) * DAY);
    await housekeeping(deps);
    const left = await db('jobs').select('status', 'payload');
    expect(
      left.map((r) => [r.status, typeof r.payload === 'string' ? JSON.parse(r.payload).n : r.payload.n]),
    ).toEqual([['dead', 'recent']]);
    await consumer.stop();
  });

  it('purges dead jobs only when the queue provides purgeDead', async () => {
    let purged = 0;
    const queue = Object.assign(new FakeQueue(), { purgeDead: async () => ++purged });
    await housekeeping(makeTestDeps({ db, queue }));
    expect(purged).toBe(1);
    await expect(housekeeping(makeTestDeps({ db }))).resolves.toBeUndefined();
  });
});
