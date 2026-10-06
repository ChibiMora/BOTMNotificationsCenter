import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb } from '../helpers/db.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';
import { cancelledScheduledDeliveries } from '../../src/lib/cancellation.js';
import { insertDeliveries } from '../../src/lib/insertDeliveries.js';
const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
describe('cancellation predicate', () => {
  it('matches removed / inactive / created at-or-before cancelled_before; not live or post-reactivation', async () => {
    const t = new Date('2026-10-01T12:00:00Z');
    const after = new Date('2026-10-01T12:00:01Z');
    const removed = await makeNotification(db, 'filter', { removed: true });
    const inactive = await makeNotification(db, 'event', { active: false });
    const reactivated = await makeNotification(db, 'csv', { cancelled_before: t });
    const live = await makeNotification(db, 'filter');
    const want = [
      await makeDelivery(db, { notification_id: removed.id, account_id: 1 }),
      await makeDelivery(db, { notification_id: inactive.id, account_id: 2 }),
      await makeDelivery(db, { notification_id: reactivated.id, account_id: 3, created_at: t }),
    ];
    await makeDelivery(db, { notification_id: reactivated.id, account_id: 4, created_at: after });
    await makeDelivery(db, { notification_id: live.id, account_id: 5 });
    await makeDelivery(db, { notification_id: removed.id, account_id: 6, sent_at: t });
    const ids = await cancelledScheduledDeliveries(db).orderBy('d.id').pluck('d.id');
    expect(ids).toEqual(want.map((d) => d.id));
  });
  it('insertDeliveries rows at or before cancelled_before are cancelled; after are not', async () => {
    const t = new Date('2026-10-01T12:00:00Z');
    const n = await makeNotification(db, 'csv', { cancelled_before: t });
    const row = (accountId: number) => ({ notificationId: n.id, accountId, dedupeKey: 'import', dueAt: t });
    await insertDeliveries(db, [row(1)], { now: new Date('2026-10-01T11:59:59Z') });
    await insertDeliveries(db, [row(2)], { now: new Date('2026-10-01T12:00:00.900Z') });
    await insertDeliveries(db, [row(3)], { now: new Date('2026-10-01T12:00:01Z') });
    const accounts = await cancelledScheduledDeliveries(db).orderBy('d.account_id').pluck('d.account_id');
    expect(accounts).toEqual([1, 2]);
  });
});

describe('cancellation SQL constants agree with the builder', () => {
  it('matrix active x removed x cancelled_before {NULL, before, equal, after created_at}', async () => {
    const { CANCELLED_SQL, NOT_CANCELLED_SQL } = await import('../../src/lib/cancellation.js');
    const created = new Date('2026-10-01T12:00:00Z');
    const cbs = [null, new Date(created.getTime() - 1000), created, new Date(created.getTime() + 1000)];
    const all: number[] = [];
    for (const active of [true, false])
      for (const removed of [true, false])
        for (const cb of cbs) {
          const n = await makeNotification(db, 'event', { active, removed, cancelled_before: cb });
          const r = await makeDelivery(db, { notification_id: n.id, account_id: 1, sent_at: null }, created);
          all.push(typeof r === 'object' ? (r as { id: number }).id : (r as number));
        }
    const base = () =>
      db('notification_deliveries as d')
        .join('notifications as n', 'n.id', 'd.notification_id')
        .whereNull('d.sent_at');
    const sorted = (xs: unknown[]) => xs.map(Number).sort((a, b) => a - b);
    const builder = sorted(await cancelledScheduledDeliveries(db).pluck('d.id'));
    const cancelled = sorted(await base().whereRaw(CANCELLED_SQL).pluck('d.id'));
    const notCancelled = sorted(await base().whereRaw(NOT_CANCELLED_SQL).pluck('d.id'));
    expect(cancelled).toEqual(builder);
    expect(sorted([...cancelled, ...notCancelled])).toEqual(sorted(all));
    expect(cancelled.filter((id) => notCancelled.includes(id))).toEqual([]);
    expect(cancelled.length).toBe(14);
  });
});
