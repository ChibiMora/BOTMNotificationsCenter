// Housekeeping's cancelled-delivery cleanup uses the same lock + rule re-check as cancel_scheduled (§8.3, §7.4):
// a notification re-activated by a concurrent admin transaction keeps its scheduled deliveries.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps } from '../helpers/deps.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';
import { housekeeping } from '../../src/scheduler/housekeeping.js';
import { createLogger } from '../../src/lib/logger.js';

const LOCKED_MSG = 'housekeeping: notification row locked elsewhere, cancelled rows skipped';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

describe('housekeeping cancelled-delivery cleanup', () => {
  it('does not delete a delivery whose notification is being re-activated at delete time', async () => {
    const log = createLogger('silent');
    const infos: Array<[unknown, unknown]> = [];
    log.info = ((obj: unknown, msg?: unknown) => void infos.push([obj, msg])) as typeof log.info;
    const deps = makeTestDeps({ db, log });
    const now = deps.clock.now();
    const n = await makeNotification(db, 'event', { active: false });
    const d = await makeDelivery(db, {
      notification_id: n.id,
      account_id: 1,
      sent_at: null,
      due_at: now,
      dedupe_key: 'k',
    });
    // An admin re-activation holds the notification row; housekeeping's candidate read still sees it cancelled.
    const trx = await db.transaction();
    try {
      await trx('notifications').where('id', n.id).update({ active: true });
      const run = housekeeping(deps);
      // Wait until housekeeping has actually hit the CONTENDED path before releasing the lock (no timing guess).
      const deadline = Date.now() + 10_000;
      while (!infos.some(([, m]) => m === LOCKED_MSG) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await trx.commit();
      await run;
    } catch (e) {
      await trx.rollback().catch(() => undefined);
      throw e;
    }
    expect(infos.filter(([, m]) => m === LOCKED_MSG)).toEqual([[{ notificationId: n.id }, LOCKED_MSG]]);
    expect(await db('notification_deliveries').pluck('id')).toEqual([d.id]);
  });

  it('still deletes cancelled deliveries of uncontended notifications', async () => {
    const deps = makeTestDeps({ db });
    const now = deps.clock.now();
    const n = await makeNotification(db, 'event', { active: false });
    await makeDelivery(db, {
      notification_id: n.id,
      account_id: 1,
      sent_at: null,
      due_at: now,
      dedupe_key: 'k',
    });
    await housekeeping(deps);
    expect(await db('notification_deliveries').count({ c: '*' })).toEqual([{ c: 0 }]);
  });
});

describe('housekeeping enqueue failures', () => {
  it('one failing enqueue is counted and the rest are still enqueued', async () => {
    const { FakeQueue } = await import('../helpers/fakeQueue.js');
    const { RecordingMetrics } = await import('../helpers/deps.js');
    const a = await makeNotification(db, 'filter', { active: true });
    const b = await makeNotification(db, 'filter', { active: true });
    const queue = new FakeQueue();
    const real = queue.enqueue.bind(queue);
    let calls = 0;
    queue.enqueue = (async (...args: Parameters<typeof real>) => {
      if (calls++ === 0) throw new Error('queue down');
      return real(...args);
    }) as typeof queue.enqueue;
    const metrics = new RecordingMetrics();
    expect(a.id).toBeLessThan(b.id);
    await housekeeping(makeTestDeps({ db, queue, metrics }));
    expect(queue.enqueued.map((e) => e.payload)).toEqual([{ notificationId: b.id }]);
    expect(metrics.calls.filter((c) => c.name === 'housekeeping_enqueue_failed')).toEqual([
      { kind: 'count', name: 'housekeeping_enqueue_failed', value: 1, dims: { type: 'fanout_filter' } },
    ]);
  });
});
