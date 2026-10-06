// Due-send timer (§7.4, §8.3 Due-send row; B10): releases due scheduled rows, every worker, batch per transaction.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, testConfig } from '../helpers/db.js';
import { ownLocks, recordLocks } from '../helpers/locks.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { makeNotification } from '../helpers/factories.js';
import { insertDeliveries } from '../../src/lib/insertDeliveries.js';
import { dueSendTimer, dueSendPass } from '../../src/scheduler/dueSend.js';
import { eventDelivery } from '../../src/jobs/eventDelivery.js';
import type { FixedClock } from '../helpers/clock.js';
import type { Knex } from 'knex';
import { cancelledScheduledDeliveries } from '../../src/lib/cancellation.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
const ctx = { attempt: 1, heartbeat: async () => {} };
const NOW = new Date('2026-10-04T14:30:00Z');
const ms = (d: unknown) => new Date(d as Date).getTime();
const depsWith = (batch: number) => makeTestDeps({ db, config: { ...testConfig(), dueSendBatch: batch } });
const pending = async () =>
  Number((await db('notification_deliveries').whereNull('sent_at').count({ n: '*' }).first())!.n);

/** `due` rows due before NOW and `later` rows not yet due, all scheduled, for one active notification. */
async function seed(due: number, later = 0) {
  const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 1 });
  const mk = (i: number, dueAt: Date) => ({
    notificationId: n.id,
    accountId: (i % 72) + 1,
    dedupeKey: `k${i}`,
    dueAt,
  });
  const rows = [
    ...Array.from({ length: due }, (_, i) => mk(i, new Date('2026-10-04T14:00:00Z'))),
    ...Array.from({ length: later }, (_, i) => mk(due + i, new Date('2026-10-05T00:00:00Z'))),
  ];
  await insertDeliveries(db, rows, { now: new Date('2026-10-03T00:00:00Z') });
  return n;
}

describe('due-send', () => {
  it('delayed event: invisible until due, then live with sent_at = release time (not due_at)', async () => {
    const deps = depsWith(100);
    const clock = deps.clock as FixedClock;
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 5 });
    await eventDelivery(
      deps,
      { type: 'shipped', accountId: 1, occurredAt: '2026-10-04T14:00:00Z', occurrenceKey: 's' },
      ctx,
    );
    await dueSendTimer(deps).run(deps);
    expect((await db('notification_deliveries').first()).sent_at).toBeNull();
    clock.set('2026-10-09T15:10:00Z');
    await dueSendTimer(deps).run(deps);
    const d = await db('notification_deliveries').first();
    expect(ms(d.sent_at)).toBe(ms('2026-10-09T15:10:00Z'));
    expect(ms(d.due_at)).toBe(ms('2026-10-09T14:00:00Z'));
    expect(
      (deps.metrics as RecordingMetrics).calls.some(
        (c) => c.kind === 'gauge' && c.name === 'due_send_lag_seconds',
      ),
    ).toBe(true);
  });

  it('batches across several passes; not-yet-due rows untouched; idempotent', async () => {
    const deps = depsWith(4);
    await seed(10, 3);
    await dueSendTimer(deps).run(deps);
    expect(await pending()).toBe(3);
    const sent = await db('notification_deliveries').whereNotNull('sent_at');
    expect(sent).toHaveLength(10);
    expect(sent.every((r) => ms(r.sent_at) === NOW.getTime())).toBe(true);
    (deps.clock as FixedClock).advance(60_000);
    await dueSendTimer(deps).run(deps);
    const again = await db('notification_deliveries').whereNotNull('sent_at');
    expect(again.every((r) => ms(r.sent_at) === NOW.getTime())).toBe(true);
    expect(await pending()).toBe(3);
  });

  it('two overlapping runs release every due row exactly once, both making progress', async () => {
    const a = depsWith(5);
    const b = depsWith(5);
    await seed(23);
    const trx = await db.transaction();
    try {
      const heldByA = await dueSendPass(a, trx); // A's batch transaction is held open
      expect(heldByA).toBe(5);
      await dueSendTimer(b).run(b); // B skips A's locked rows and releases the rest
      expect(await pending()).toBe(5);
      await trx.commit();
    } finally {
      if (!trx.isCompleted()) await trx.rollback();
    }
    expect(await pending()).toBe(0);
    const total = (d: typeof a) =>
      (d.metrics as RecordingMetrics).calls
        .filter((c) => c.name === 'due_send_released')
        .reduce((s, c) => s + c.value, 0);
    expect(total(a) + total(b)).toBe(23);
    expect(total(b)).toBe(18);
    await Promise.all([dueSendTimer(a).run(a), dueSendTimer(b).run(b)]);
    expect(total(a) + total(b)).toBe(23);
  });

  it('concurrent runs on a large backlog never release a row twice', async () => {
    const a = depsWith(7);
    const b = depsWith(7);
    await seed(60);
    await Promise.all([dueSendTimer(a).run(a), dueSendTimer(b).run(b)]);
    expect(await pending()).toBe(0);
    const total = [a, b]
      .flatMap((d) => (d.metrics as RecordingMetrics).calls)
      .filter((c) => c.name === 'due_send_released')
      .reduce((s, c) => s + c.value, 0);
    expect(total).toBe(60);
  });

  it('lock footprint: delivery locks proportional to the batch; no EXCLUSIVE lock on notifications', async () => {
    const deps = depsWith(5);
    await seed(60, 60);
    const trx = await db.transaction();
    try {
      await dueSendPass(deps, trx);
      const by: Record<string, number> = {};
      for (const l of await ownLocks(db)) if (l.type === 'RECORD') by[l.table] = (by[l.table] ?? 0) + 1;
      const nLocks = (await recordLocks(db, 'notifications')).map((l) => ({ m: l.mode }));
      console.info('due-send notifications record locks:', JSON.stringify(nLocks.map((l) => l.m)));
      expect(nLocks.filter((l) => /^X/.test(l.m))).toEqual([]);
      const n = await db('notifications').first('id');
      const admin = await db.transaction();
      try {
        await admin.raw('SELECT id FROM notifications WHERE id = ? FOR UPDATE NOWAIT', [n.id]);
      } finally {
        await admin.rollback();
      }
      expect(by.notification_deliveries).toBeGreaterThan(0);
      expect(by.notification_deliveries).toBeLessThanOrEqual(5 * 3);
    } finally {
      await trx.rollback();
    }
  });

  it('lock footprint on other tables: shared accounts locks bounded by the batch, none exclusive; none on notifications', async () => {
    const deps = depsWith(5);
    await seed(60, 60);
    const trx = await db.transaction();
    try {
      await dueSendPass(deps, trx);
      const locks = (await ownLocks(db))
        .filter((l) => l.type === 'RECORD' && l.table !== 'notification_deliveries')
        .map((l) => ({ t: l.table, m: l.mode, i: l.index }));
      console.info('due-send non-delivery record locks:', JSON.stringify(locks));
      const accounts = locks.filter((l) => l.t === 'accounts');
      expect(accounts.length).toBeLessThanOrEqual(5);
      expect(accounts.filter((l) => /^X/.test(l.m))).toEqual([]);
      expect(locks.filter((l) => l.t === 'notifications')).toEqual([]);
      expect(locks.filter((l) => l.t !== 'accounts' && l.t !== 'notifications')).toEqual([]);
    } finally {
      await trx.rollback();
    }
  });
});

/** Wraps the batch transaction so `before` commits on ANOTHER connection right before the release UPDATE runs. */
function hookRelease(trx: Knex.Transaction, before: () => Promise<unknown>): Knex.Transaction {
  return new Proxy(trx, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p !== 'raw') return typeof v === 'function' ? v.bind(t) : v;
      return (...args: [string, ...unknown[]]) =>
        /^\s*UPDATE/i.test(args[0])
          ? before().then(() => (t.raw as (...a: unknown[]) => unknown)(...args))
          : (t.raw as (...a: unknown[]) => unknown)(...args);
    },
  });
}
const counted = (deps: ReturnType<typeof depsWith>, name: string) =>
  (deps.metrics as RecordingMetrics).calls.filter((c) => c.name === name).reduce((s, c) => s + c.value, 0);

describe('due-send cancellation race (decision and write in one statement)', () => {
  for (const [label, change] of [
    ['deactivated', { active: false, cancelled_before: NOW }],
    ['removed', { removed: true }],
  ] as const) {
    it(`a ${label} notification committed after the lock step and before release: nothing goes live, all deleted`, async () => {
      const deps = depsWith(100);
      const n = await seed(3);
      let fired = false;
      await db.transaction((trx) =>
        dueSendPass(
          deps,
          hookRelease(trx, async () => {
            fired = true;
            await db('notifications').where({ id: n.id }).update(change);
          }),
        ),
      );
      expect(fired).toBe(true);
      expect(await db('notification_deliveries').whereNotNull('sent_at')).toHaveLength(0);
      expect(await db('notification_deliveries')).toHaveLength(0);
      expect(counted(deps, 'due_send_cancelled_deleted')).toBe(3);
      expect(counted(deps, 'due_send_released')).toBe(0);
    });
  }

  it('matrix: release/delete agree with the shared cancellation predicate; counts are right', async () => {
    const deps = depsWith(100);
    const T0 = new Date('2026-10-03T00:00:00Z');
    const T1 = new Date('2026-10-03T12:00:00Z');
    const expected = new Set<number>();
    let k = 0;
    for (const active of [true, false])
      for (const removed of [false, true])
        for (const cb of [null, new Date('2026-10-03T06:00:00Z'), T0]) {
          const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 1 });
          await db('notifications').where({ id: n.id }).update({ active, removed, cancelled_before: cb });
          for (const created of [T0, T1]) {
            await insertDeliveries(
              db,
              [
                {
                  notificationId: n.id,
                  accountId: 1,
                  dedupeKey: `m${k++}`,
                  dueAt: new Date('2026-10-04T14:00:00Z'),
                },
              ],
              { now: created },
            );
          }
        }
    for (const id of await cancelledScheduledDeliveries(db).pluck('d.id')) expected.add(Number(id));
    const all = (await db('notification_deliveries').pluck('id')).map(Number);
    expect(expected.size).toBeGreaterThan(0);
    expect(expected.size).toBeLessThan(all.length);
    const handled = await db.transaction((trx) => dueSendPass(deps, trx));
    expect(handled).toBe(all.length);
    const left = await db('notification_deliveries').select('id', 'sent_at');
    expect(left.every((r) => ms(r.sent_at) === NOW.getTime())).toBe(true);
    expect(left.map((r) => Number(r.id)).sort()).toEqual(all.filter((id) => !expected.has(id)).sort());
    expect(counted(deps, 'due_send_released')).toBe(all.length - expected.size);
    expect(counted(deps, 'due_send_cancelled_deleted')).toBe(expected.size);
  });

  it('reactivated notification: a row created at/before cancelled_before is deleted, one created after is released', async () => {
    const deps = depsWith(100);
    const n = await seed(1); // created 2026-10-03T00:00:00Z
    await db('notifications')
      .where({ id: n.id })
      .update({ active: true, cancelled_before: new Date('2026-10-03T00:00:00Z') });
    await insertDeliveries(
      db,
      [{ notificationId: n.id, accountId: 2, dedupeKey: 'after', dueAt: new Date('2026-10-04T14:00:00Z') }],
      { now: new Date('2026-10-03T00:00:01Z') },
    );
    await db.transaction((trx) => dueSendPass(deps, trx));
    const left = await db('notification_deliveries');
    expect(left.map((r) => r.dedupe_key)).toEqual(['after']);
    expect(ms(left[0].sent_at)).toBe(NOW.getTime());
  });

  it('an admin SELECT … FOR UPDATE NOWAIT on the notification succeeds while a due-send batch is open', async () => {
    const deps = depsWith(5);
    const n = await seed(20);
    const trx = await db.transaction();
    try {
      expect(await dueSendPass(deps, trx)).toBe(5);
      const admin = await db.transaction();
      try {
        const rows = await admin.raw('SELECT id FROM notifications WHERE id = ? FOR UPDATE NOWAIT', [n.id]);
        expect(rows[0]).toHaveLength(1);
      } finally {
        await admin.rollback();
      }
    } finally {
      await trx.rollback();
    }
  });
});
