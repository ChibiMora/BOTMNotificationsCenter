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
