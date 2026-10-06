import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb } from '../helpers/db.js';
import { makeNotification } from '../helpers/factories.js';
import { insertDeliveries } from '../../src/lib/insertDeliveries.js';
const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
const due = new Date('2026-10-01T00:00:00Z');
const now = new Date('2026-10-04T14:30:00.750Z');
describe('insertDeliveries', () => {
  it('repeat is a no-op counted alreadyDelivered', async () => {
    const n = await makeNotification(db, 'csv');
    const rows = [1, 2].map((accountId) => ({
      notificationId: n.id,
      accountId,
      dedupeKey: 'import',
      dueAt: due,
    }));
    expect(await insertDeliveries(db, rows, { now })).toEqual({
      inserted: 2,
      alreadyDelivered: 0,
      unknownAccounts: [],
    });
    expect(await insertDeliveries(db, rows, { now })).toEqual({
      inserted: 0,
      alreadyDelivered: 2,
      unknownAccounts: [],
    });
  });
  it('public_id clash is re-inserted with a fresh id', async () => {
    const n = await makeNotification(db, 'csv');
    await insertDeliveries(db, [{ notificationId: n.id, accountId: 1, dedupeKey: 'import', dueAt: due }], {
      now,
      newId: () => 'dl_AAAAAAAAAAAA',
    });
    const ids = ['dl_AAAAAAAAAAAA', 'dl_BBBBBBBBBBBB'];
    const r = await insertDeliveries(
      db,
      [{ notificationId: n.id, accountId: 2, dedupeKey: 'import', dueAt: due }],
      { now, newId: () => ids.shift()! },
    );
    expect(r).toEqual({ inserted: 1, alreadyDelivered: 0, unknownAccounts: [] });
    expect(await db('notification_deliveries').where({ account_id: 2 }).first()).toMatchObject({
      public_id: 'dl_BBBBBBBBBBBB',
    });
  });
  it('unknown account is returned, not swallowed', async () => {
    const n = await makeNotification(db, 'event');
    const r = await insertDeliveries(
      db,
      [
        { notificationId: n.id, accountId: 1, dedupeKey: 'k1', occurrenceKey: 'k1', dueAt: due },
        { notificationId: n.id, accountId: 9999, dedupeKey: 'k1', occurrenceKey: 'k1', dueAt: due },
      ],
      { now },
    );
    expect(r.unknownAccounts).toEqual([9999]);
    expect(r.inserted).toBe(1);
  });
  it('missing required value raises (strict mode) and inserts nothing', async () => {
    const n = await makeNotification(db, 'csv');
    await expect(
      insertDeliveries(
        db,
        [
          { notificationId: n.id, accountId: 1, dedupeKey: 'import', dueAt: due },
          { notificationId: n.id, accountId: 2, dedupeKey: 'import', dueAt: undefined as unknown as Date },
        ],
        { now },
      ),
    ).rejects.toThrow();
    expect(await db('notification_deliveries').count({ c: '*' }).first()).toMatchObject({ c: 0 });
  });
  it('rows for the same unknown account are not counted alreadyDelivered', async () => {
    const n1 = await makeNotification(db, 'event');
    const n2 = await makeNotification(db, 'event');
    const r = await insertDeliveries(
      db,
      [
        { notificationId: n1.id, accountId: 9998, dedupeKey: 'k1', dueAt: due },
        { notificationId: n1.id, accountId: 9999, dedupeKey: 'k1', dueAt: due },
        { notificationId: n2.id, accountId: 9999, dedupeKey: 'k1', dueAt: due },
        { notificationId: n1.id, accountId: 1, dedupeKey: 'k1', dueAt: due },
      ],
      { now },
    );
    expect(r).toEqual({ inserted: 1, alreadyDelivered: 0, unknownAccounts: [9998, 9999] });
  });
  it('mixed batch (new + repeat + unknown + public_id clash) counts all three', async () => {
    const n = await makeNotification(db, 'csv');
    const clash = 'dl_AAAAAAAAAAAA';
    await insertDeliveries(db, [{ notificationId: n.id, accountId: 1, dedupeKey: 'import', dueAt: due }], {
      now,
      newId: () => clash,
    });
    let calls = 0;
    const newId = () => {
      calls++;
      return calls <= 5 ? clash : `dl_C${String(calls).padStart(11, '0')}`;
    };
    const r = await insertDeliveries(
      db,
      [
        { notificationId: n.id, accountId: 1, dedupeKey: 'import', dueAt: due },
        { notificationId: n.id, accountId: 2, dedupeKey: 'import', dueAt: due },
        { notificationId: n.id, accountId: 9999, dedupeKey: 'import', dueAt: due },
      ],
      { now, newId },
    );
    expect(r).toEqual({ inserted: 1, alreadyDelivered: 1, unknownAccounts: [9999] });
  });
  it('dedupe keys compare exactly (binary collation)', async () => {
    const n = await makeNotification(db, 'event');
    const row = (dedupeKey: string) => ({
      notificationId: n.id,
      accountId: 1,
      dedupeKey,
      occurrenceKey: dedupeKey,
      dueAt: due,
    });
    expect(await insertDeliveries(db, [row('abc')], { now })).toMatchObject({ inserted: 1 });
    expect(await insertDeliveries(db, [row('ABC')], { now })).toMatchObject({
      inserted: 1,
      alreadyDelivered: 0,
    });
    expect(await insertDeliveries(db, [row('abc')], { now })).toMatchObject({
      inserted: 0,
      alreadyDelivered: 1,
    });
    expect(
      await db('notification_deliveries').where({ notification_id: n.id }).count({ c: '*' }).first(),
    ).toMatchObject({ c: 2 });
  });
  it('connection session is UTC with strict mode', async () => {
    const [rows] = await db.raw('SELECT @@session.time_zone AS tz, @@session.sql_mode AS mode');
    expect(rows[0].tz).toBe('+00:00');
    expect(rows[0].mode).toContain('STRICT_ALL_TABLES');
    expect(rows[0].mode).toContain('TIME_TRUNCATE_FRACTIONAL');
  });
  it('trailing spaces in keys are distinct keys (NO PAD collation), not a public_id clash loop', async () => {
    const n = await makeNotification(db, 'event');
    const row = (k: string) => ({
      notificationId: n.id,
      accountId: 1,
      dedupeKey: k,
      occurrenceKey: k,
      dueAt: due,
    });
    expect(await insertDeliveries(db, [row('k1')], { now })).toMatchObject({ inserted: 1 });
    expect(await insertDeliveries(db, [row('k1 ')], { now })).toMatchObject({
      inserted: 1,
      alreadyDelivered: 0,
    });
    expect(
      await db('notification_deliveries').where({ notification_id: n.id }).count({ c: '*' }).first(),
    ).toMatchObject({ c: 2 });
  });
  it('sub-second timestamps are truncated, not rounded, on every write', async () => {
    const n = await makeNotification(db, 'csv');
    await insertDeliveries(
      db,
      [
        {
          notificationId: n.id,
          accountId: 1,
          dedupeKey: 'import',
          dueAt: new Date('2026-10-01T00:00:00.700Z'),
          sentAt: new Date('2026-10-02T00:00:00.700Z'),
        },
      ],
      { now },
    );
    expect(await db('notification_deliveries').where({ notification_id: n.id }).first()).toMatchObject({
      due_at: new Date('2026-10-01T00:00:00Z'),
      sent_at: new Date('2026-10-02T00:00:00Z'),
    });
    await db.raw("UPDATE notifications SET cancelled_before = '2026-10-04 14:30:00.900' WHERE id = ?", [
      n.id,
    ]);
    expect((await db('notifications').where({ id: n.id }).first()).cancelled_before).toEqual(
      new Date('2026-10-04T14:30:00Z'),
    );
  });
  it('writes created_at from the passed now, truncated to whole seconds, on every row', async () => {
    const n = await makeNotification(db, 'csv');
    await insertDeliveries(
      db,
      [1, 2, 3].map((accountId) => ({ notificationId: n.id, accountId, dedupeKey: 'import', dueAt: due })),
      { now },
    );
    const got = await db('notification_deliveries').where({ notification_id: n.id }).pluck('created_at');
    expect(got).toEqual([1, 2, 3].map(() => new Date('2026-10-04T14:30:00Z')));
  });
  it('pooled connection runs READ-COMMITTED', async () => {
    const [rows] = await db.raw('SELECT @@session.transaction_isolation AS iso');
    expect(rows[0].iso).toBe('READ-COMMITTED');
  });
});
