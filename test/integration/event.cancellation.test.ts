// Cancellation of scheduled sends (§7.4; B5, B6): due-send deletes cancelled rows, cancel_scheduled cleans up early.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps } from '../helpers/deps.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';
import { dueSendTimer } from '../../src/scheduler/dueSend.js';
import { cancelScheduled, cancelScheduledRun } from '../../src/jobs/cancelScheduled.js';
import { housekeeping } from '../../src/scheduler/housekeeping.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
const ctx = { attempt: 1, heartbeat: async () => {} };
const DEACT = new Date('2026-10-02T00:00:00Z');
const before = new Date('2026-10-01T00:00:00Z');
const after = new Date('2026-10-03T00:00:00Z');
const due = new Date('2026-10-04T00:00:00Z');
const ids = async () => (await db('notification_deliveries').orderBy('id').pluck('id')) as number[];
const sched = (nid: number, account: number, created: Date) =>
  makeDelivery(db, { notification_id: nid, account_id: account, due_at: due, sent_at: null }, created);

describe('cancellation enforced by due-send', () => {
  it('created at or before cancelled_before: deleted, not sent, even after reactivation; one created after is sent', async () => {
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'event', {
      event_trigger: 'shipped',
      active: true,
      cancelled_before: DEACT,
    });
    const old = await sched(n.id, 1, before);
    const atEdge = await sched(n.id, 2, DEACT);
    const fresh = await sched(n.id, 3, after);
    await dueSendTimer(deps).run(deps);
    expect(await ids()).toEqual([fresh.id]);
    expect((await db('notification_deliveries').where({ id: fresh.id }).first()).sent_at).not.toBeNull();
    expect([old.id, atEdge.id].some((id) => id === fresh.id)).toBe(false);
  });

  it('a scheduled delivery inserted just after a deactivation commits (inactive) is deleted, not sent', async () => {
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'event', {
      event_trigger: 'shipped',
      active: false,
      cancelled_before: DEACT,
    });
    await sched(n.id, 1, after);
    await dueSendTimer(deps).run(deps);
    expect(await ids()).toEqual([]);
  });

  it('removed notification: scheduled rows deleted', async () => {
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, removed: true });
    await sched(n.id, 1, after);
    await dueSendTimer(deps).run(deps);
    expect(await ids()).toEqual([]);
  });
});

describe('cancel_scheduled', () => {
  async function seed() {
    const n = await makeNotification(db, 'event', {
      event_trigger: 'shipped',
      active: true,
      cancelled_before: DEACT,
    });
    const other = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    for (let a = 1; a <= 5; a++) await sched(n.id, a, before);
    const live = await makeDelivery(
      db,
      { notification_id: n.id, account_id: 9, due_at: before, sent_at: before },
      before,
    );
    const valid = await sched(n.id, 10, after);
    const otherRow = await sched(other.id, 1, before);
    return { n, keep: [live.id, valid.id, otherRow.id] };
  }

  it('removes exactly the cancelled scheduled rows in chunks, heartbeating between them', async () => {
    const deps = makeTestDeps({ db });
    const { n, keep } = await seed();
    let beats = 0;
    await cancelScheduledRun(deps, n.id, { attempt: 1, heartbeat: async () => void beats++ }, 2);
    expect(await ids()).toEqual(keep);
    expect(beats).toBeGreaterThanOrEqual(2);
  });

  it('the handler works with the default chunk; a missing notification is no error', async () => {
    const deps = makeTestDeps({ db });
    const { n, keep } = await seed();
    await cancelScheduled(deps, { notificationId: n.id }, ctx);
    expect(await ids()).toEqual(keep);
    await expect(cancelScheduled(deps, { notificationId: 987_654 }, ctx)).resolves.toBeUndefined();
  });

  it('with the job lost, housekeeping removes the cancelled rows', async () => {
    const deps = makeTestDeps({ db });
    const { keep } = await seed();
    await housekeeping(deps);
    expect(await ids()).toEqual(keep);
  });
});

describe('cancel_scheduled deletes through the cancellation rule', () => {
  it('a reactivation committed between the chunk select and the delete: the now-valid row survives', async () => {
    const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 1 });
    await db('notifications').where({ id: n.id }).update({ active: false });
    const row = await sched(n.id, 1, after);
    let fired = false;
    const realDb = makeTestDeps({ db }).db;
    const hooked = new Proxy(realDb, {
      get(t, p) {
        const v = Reflect.get(t, p, t);
        if (p !== 'transaction') return typeof v === 'function' ? v.bind(t) : v;
        // The chunk transaction (lock + delete) opens after the candidate read: reactivate in between.
        return (...args: unknown[]) => {
          fired = true;
          return db('notifications')
            .where({ id: n.id })
            .update({ active: true })
            .then(() => (t.transaction as (...a: unknown[]) => unknown)(...args));
        };
      },
    });
    const deps = makeTestDeps({ db: hooked });
    expect(await cancelScheduledRun(deps, n.id, ctx)).toBe(0);
    expect(fired).toBe(true);
    expect(await ids()).toEqual([typeof row === 'object' ? (row as { id: number }).id : row]);
  });
});

const lockWaits = async () =>
  Number(
    (
      (await db.raw('SELECT COUNT(*) AS c FROM performance_schema.data_lock_waits'))[0] as Array<{
        c: number;
      }>
    )[0]!.c,
  );
const idOf = (row: unknown) => (typeof row === 'object' ? (row as { id: number }).id : (row as number));

describe('cancel_scheduled never waits while holding the notification lock', () => {
  it('a delivery row locked elsewhere is skipped: the chunk completes, the admin NOWAIT succeeds, a later run deletes it', async () => {
    const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: false });
    const a = idOf(await sched(n.id, 1, before));
    const held = idOf(await sched(n.id, 2, before));
    const c = idOf(await sched(n.id, 3, before));
    const holder = await db.transaction();
    try {
      await holder('notification_deliveries').where({ id: held }).forUpdate().select('id');
      // Completes while the holder still holds its row: the job never waited on it.
      expect(await cancelScheduledRun(makeTestDeps({ db }), n.id, ctx)).toBe(2);
      expect(await lockWaits()).toBe(0);
      expect(await ids()).toEqual([held]);
      expect([a, c]).not.toContain(held);
      const admin = await db.transaction();
      try {
        await expect(
          admin.raw('SELECT id FROM notifications WHERE id = ? FOR UPDATE NOWAIT', [n.id]),
        ).resolves.toBeDefined();
      } finally {
        await admin.rollback();
      }
    } finally {
      await holder.rollback();
    }
    expect(await cancelScheduledRun(makeTestDeps({ db }), n.id, ctx)).toBe(1);
    expect(await ids()).toEqual([]);
  });

  it('a full candidate chunk entirely locked elsewhere: the run ends at once with 0 deleted', async () => {
    const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: false });
    const rows = [idOf(await sched(n.id, 1, before)), idOf(await sched(n.id, 2, before))];
    let statements = 0;
    const CAP = 10;
    const counter = () => void statements++;
    db.on('query', counter);
    const holder = await db.transaction();
    try {
      await holder('notification_deliveries').whereIn('id', rows).forUpdate().select('id');
      statements = 0;
      let overCap!: () => void;
      const capped = new Promise<never>((_, reject) => {
        overCap = () => reject(new Error(`cancel_scheduled issued more than ${CAP} statements`));
      });
      const watch = () => void (statements > CAP && overCap());
      db.on('query', watch);
      try {
        expect(await Promise.race([cancelScheduledRun(makeTestDeps({ db }), n.id, ctx, 2), capped])).toBe(0);
      } finally {
        db.off('query', watch);
      }
      expect(statements).toBeLessThanOrEqual(CAP);
      expect(await lockWaits()).toBe(0);
    } finally {
      db.off('query', counter);
      await holder.rollback();
    }
    expect(await ids()).toEqual(rows);
  });
});
