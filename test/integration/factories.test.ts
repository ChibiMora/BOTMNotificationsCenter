import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb } from '../helpers/db.js';
import { makeNotification, makeDelivery, makeImport } from '../helpers/factories.js';
import { FixedClock } from '../helpers/clock.js';
const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
describe('factories', () => {
  it('timestamps default to the fixed clock, never the wall clock', async () => {
    const t = new FixedClock().now();
    const n = await makeNotification(db, 'filter');
    const d = await makeDelivery(db, { notification_id: n.id, account_id: 1 });
    const i = await makeImport(db, { notification_id: n.id });
    expect(n.created_at).toEqual(t);
    expect(d.created_at).toEqual(t);
    expect(i.created_at).toEqual(t);
    expect(i.updated_at).toEqual(t);
  });
  it('timestamps follow an explicit now argument', async () => {
    const t = new Date('2026-09-01T08:00:00Z');
    const n = await makeNotification(db, 'event', {}, t);
    const d = await makeDelivery(db, { notification_id: n.id, account_id: 1 }, t);
    const i = await makeImport(db, { notification_id: n.id }, t);
    expect([n.created_at, d.created_at, i.created_at, i.updated_at]).toEqual([t, t, t, t]);
  });
});
