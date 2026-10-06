// Cancellation of scheduled sends (§7.4; B5, B6): due-send deletes cancelled rows, cancel_scheduled cleans up early.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb } from '../helpers/db.js';
import { lockWaits, ownLocks } from '../helpers/locks.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
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
      expect(await lockWaits(db)).toBe(0);
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
      expect(await lockWaits(db)).toBe(0);
    } finally {
      db.off('query', counter);
      await holder.rollback();
    }
    expect(await ids()).toEqual(rows);
  });
});

const deliveryLocks = async () => (await ownLocks(db, 'notification_deliveries')).length;

describe('cancel_scheduled gives up instead of waiting on the notification row', () => {
  it('notification row held FOR UPDATE elsewhere: the run returns at once with 0, no waits, no locks, counted; after commit it deletes', async () => {
    const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: false });
    const rows = [idOf(await sched(n.id, 1, before)), idOf(await sched(n.id, 2, before))];
    const deps = makeTestDeps({ db });
    const admin = await db.transaction();
    let failDelete!: () => void;
    const deleteIssued = new Promise<never>((_, reject) => {
      failDelete = () => reject(new Error('cancel_scheduled issued its DELETE behind the admin lock'));
    });
    deleteIssued.catch(() => undefined);
    const watch = (q: { sql: string }) => void (/^\s*delete/i.test(q.sql) && failDelete());
    db.on('query', watch);
    try {
      await admin.raw('SELECT id FROM notifications WHERE id = ? FOR UPDATE', [n.id]);
      expect(await Promise.race([cancelScheduledRun(deps, n.id, ctx), deleteIssued])).toBe(0);
      expect(await lockWaits(db)).toBe(0);
      expect(await deliveryLocks()).toBe(0);
      expect(
        (deps.metrics as RecordingMetrics).calls.filter((c) => c.name === 'cancel_scheduled_contended'),
      ).toHaveLength(1);
      expect(await ids()).toEqual(rows);
    } finally {
      db.off('query', watch);
      await admin.commit();
    }
    expect(await cancelScheduledRun(makeTestDeps({ db }), n.id, ctx)).toBe(2);
    expect(await ids()).toEqual([]);
  });
});

describe('cancel_scheduled pages by id', () => {
  it('every other row locked elsewhere: one run visits each candidate once, deletes exactly the unlocked ones, ends', async () => {
    const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: false });
    const all: number[] = [];
    for (let a = 1; a <= 7; a++) all.push(idOf(await sched(n.id, a, before)));
    const lockedRows = all.filter((_, i) => i % 2 === 1);
    const free = all.filter((_, i) => i % 2 === 0);
    const visited: number[] = [];
    let statements = 0;
    const CAP = 30;
    let overCap!: () => void;
    const capped = new Promise<never>((_, reject) => {
      overCap = () => reject(new Error(`cancel_scheduled issued more than ${CAP} statements`));
    });
    capped.catch(() => undefined);
    const watch = () => void (++statements > CAP && overCap());
    const record = (response: unknown, q: { sql: string }) => {
      if (/^\s*select/i.test(q.sql) && /notification_deliveries/.test(q.sql) && !/\bfor\b/i.test(q.sql)) {
        for (const r of response as unknown[]) visited.push(idOf(r));
      }
    };
    const holder = await db.transaction();
    try {
      await holder('notification_deliveries').whereIn('id', lockedRows).forUpdate().select('id');
      db.on('query', watch);
      db.on('query-response', record);
      const deleted = await Promise.race([cancelScheduledRun(makeTestDeps({ db }), n.id, ctx, 2), capped]);
      expect(deleted).toBe(free.length);
      expect([...visited].sort((x, y) => x - y)).toEqual(all);
      expect(await lockWaits(db)).toBe(0);
    } finally {
      db.off('query', watch);
      db.off('query-response', record);
      await holder.rollback();
    }
    expect(await ids()).toEqual(lockedRows);
  });
});
