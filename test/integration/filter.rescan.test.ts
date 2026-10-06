// Rescan timer (§8.3 row, §7.2 step 8): the safety net for unreported account changes and lost enqueues.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, updateAccount } from '../helpers/db.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { makeNotification } from '../helpers/factories.js';
import { FakeQueue } from '../helpers/fakeQueue.js';
import { rescan, rescanTimer } from '../../src/scheduler/rescan.js';
import { jobHandlers, onDead } from '../../src/jobs/index.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
const ids = async (nid: number) =>
  (await db('notification_deliveries').where({ notification_id: nid }).orderBy('account_id')).map(
    (r) => r.account_id,
  );
const setup = async () => {
  const deps = makeTestDeps({ db });
  const q = deps.queue as FakeQueue;
  await q.consume(jobHandlers(deps), { onDead: onDead(deps) });
  return { deps, q, rescan: () => rescanTimer(deps).run(deps) };
};
const fanouts = (q: FakeQueue) => q.enqueued.filter((e) => e.type === 'fanout_filter').map((e) => e.payload);

describe('rescan', () => {
  it('enqueues one fanout_filter per active filter notification, none for inactive/removed/event/csv', async () => {
    const { q, rescan } = await setup();
    const a = await makeNotification(db, 'filter', { active: true });
    await makeNotification(db, 'filter', { active: false });
    await makeNotification(db, 'filter', { active: true, removed: true });
    await makeNotification(db, 'event', { active: true });
    await makeNotification(db, 'csv', { active: true });
    const b = await makeNotification(db, 'filter', { active: true });
    await rescan();
    expect(fanouts(q)).toEqual([{ notificationId: a.id }, { notificationId: b.id }]);
  });

  it('an account that becomes eligible unreported is added by the next rescan, and only that account', async () => {
    const { deps, q, rescan } = await setup();
    // Account 2 = US/monthly/new_member/1; the filter wants bff.
    const n = await makeNotification(db, 'filter', {
      active: true,
      filters: JSON.stringify({ relationshipStatus: ['bff'] }),
    });
    await deps.queue.enqueue('fanout_filter', { notificationId: n.id });
    await q.runAll();
    const first = await ids(n.id);
    expect(first).toEqual([
      13, 14, 15, 16, 17, 18, 31, 32, 33, 34, 35, 36, 49, 50, 51, 52, 53, 54, 67, 68, 69, 70, 71, 72,
    ]);
    await updateAccount(db, 2, { relationship_status: 'bff' });
    await rescan();
    await q.runAll();
    expect(await ids(n.id)).toEqual([2, ...first]);
  });

  it('lost enqueue on activation: the next rescan still sends it', async () => {
    const { deps, q, rescan } = await setup();
    const n = await makeNotification(db, 'filter', { active: true });
    q.failNextEnqueue(new Error('queue down'));
    await expect(deps.queue.enqueue('fanout_filter', { notificationId: n.id })).rejects.toThrow('queue down');
    await rescan();
    await q.runAll();
    expect(await ids(n.id)).toEqual(Array.from({ length: 72 }, (_, i) => i + 1));
  });

  it('a failing enqueue for one notification does not stop the others', async () => {
    const { q, rescan } = await setup();
    const a = await makeNotification(db, 'filter', { active: true });
    const b = await makeNotification(db, 'filter', { active: true });
    q.failNextEnqueue(new Error('queue down'));
    await expect(rescan()).resolves.toBeUndefined();
    expect(fanouts(q)).toEqual([{ notificationId: b.id }]);
    expect(a.id).toBeLessThan(b.id);
  });
});

describe('rescan: paging and failure metric', () => {
  it('more than one page of active filter notifications: exactly one enqueue each, none twice', async () => {
    const deps = makeTestDeps({ db });
    const made: number[] = [];
    for (let i = 0; i < 5; i++) made.push((await makeNotification(db, 'filter', { active: true })).id);
    await rescan(deps, { page: 2 });
    expect(fanouts(deps.queue as FakeQueue)).toEqual(made.map((notificationId) => ({ notificationId })));
    const exact = makeTestDeps({ db });
    await makeNotification(db, 'filter', { active: true });
    await rescan(exact, { page: 3 }); // 6 notifications: two full pages, then an empty one
    expect(fanouts(exact.queue as FakeQueue)).toHaveLength(6);
  });
  it('counts rescan_enqueue_failed for a failed enqueue', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'filter', { active: true });
    await makeNotification(db, 'filter', { active: true });
    (deps.queue as FakeQueue).failNextEnqueue(new Error('queue down'));
    await rescan(deps);
    const m = (deps.metrics as RecordingMetrics).calls;
    expect(m).toContainEqual(expect.objectContaining({ name: 'rescan_enqueue_failed', value: 1 }));
    expect(m).toContainEqual(expect.objectContaining({ name: 'rescan_enqueued', value: 1 }));
  });
});
