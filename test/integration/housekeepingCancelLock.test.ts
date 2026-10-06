// Housekeeping's cancelled-delivery cleanup uses the same lock + rule re-check as cancel_scheduled (§8.3, §7.4):
// a notification re-activated by a concurrent admin transaction keeps its scheduled deliveries.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps } from '../helpers/deps.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';
import { housekeeping } from '../../src/scheduler/housekeeping.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

describe('housekeeping cancelled-delivery cleanup', () => {
  it('does not delete a delivery whose notification is being re-activated at delete time', async () => {
    const deps = makeTestDeps({ db });
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
      await new Promise((r) => setTimeout(r, 300));
      await trx.commit();
      await run;
    } catch (e) {
      await trx.rollback().catch(() => undefined);
      throw e;
    }
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
    await housekeeping(makeTestDeps({ db, queue, metrics }));
    expect(queue.enqueued.map((e) => e.payload)).toEqual([{ notificationId: b.id }]);
    expect(JSON.stringify(metrics)).toContain('housekeeping_enqueue_failed');
    expect(a.id).toBeLessThan(b.id);
  });
});
