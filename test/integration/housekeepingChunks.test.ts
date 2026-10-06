// Housekeeping chunking (§8.3): both scans work in bounded, id-ordered chunks and terminate.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps } from '../helpers/deps.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';
import { FakeQueue } from '../helpers/fakeQueue.js';
import { housekeeping } from '../../src/scheduler/housekeeping.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

describe('housekeeping chunks', () => {
  it('deletes more cancelled deliveries than one chunk, keeps the rest, and terminates', async () => {
    const deps = makeTestDeps({ db });
    const now = deps.clock.now();
    const gone = await makeNotification(db, 'event', { active: false });
    for (let i = 0; i < 5; i++) {
      await makeDelivery(db, {
        notification_id: gone.id,
        account_id: i + 1,
        sent_at: null,
        due_at: now,
        dedupe_key: `k${i}`,
      });
    }
    const sent = await makeDelivery(db, {
      notification_id: gone.id,
      account_id: 9,
      sent_at: now,
      dedupe_key: 's',
    });
    await housekeeping(deps, { chunk: 2 });
    expect(await db('notification_deliveries').pluck('id')).toEqual([sent.id]);
  });

  it('enqueues every orphan filter notification across several chunks, in id order', async () => {
    const deps = makeTestDeps({ db });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await makeNotification(db, 'filter', { active: true })).id);
    await housekeeping(deps, { chunk: 2 });
    const q = deps.queue as FakeQueue;
    expect(q.enqueued.filter((e) => e.type === 'fanout_filter').map((e) => e.payload)).toEqual(
      ids.map((notificationId) => ({ notificationId })),
    );
  });
});
