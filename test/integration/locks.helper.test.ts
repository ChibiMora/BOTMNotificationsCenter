// Test helpers that read server-wide lock tables count only this run's database (DB_NAME), never another one.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Knex } from 'knex';
import { testDb, testConfig, resetDb } from '../helpers/db.js';
import { makeNotification } from '../helpers/factories.js';
import { lockWaits, ownLocks } from '../helpers/locks.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
const OTHER = `${testConfig().dbName}_other`;

/** Waits (server-wide) whose requesting lock is on `schema`; used only to see the blocked statement arrive. */
const waitsIn = async (schema: string) =>
  Number(
    (
      await db.raw(
        `SELECT COUNT(*) AS c FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
         WHERE l.OBJECT_SCHEMA = ?`,
        [schema],
      )
    )[0][0].c,
  );

/** One transaction holds `id` FOR UPDATE on `table`, a second is blocked on it; `check` runs while it waits. */
async function withLockWait(schema: string, table: string, id: number, check: () => Promise<void>) {
  const before = await waitsIn(schema);
  const holder = await db.transaction();
  let waiter: Knex.Transaction | undefined;
  let blocked: Promise<unknown> | undefined;
  try {
    await holder.raw('SELECT id FROM ??.?? WHERE id = ? FOR UPDATE', [schema, table, id]);
    waiter = await db.transaction();
    blocked = waiter
      .raw('SELECT id FROM ??.?? WHERE id = ? FOR UPDATE', [schema, table, id])
      .catch(() => undefined);
    for (let i = 0; (await waitsIn(schema)) <= before; i++) {
      if (i > 10_000) throw new Error('blocked statement never started waiting');
    }
    await check();
  } finally {
    try {
      await holder.rollback();
    } finally {
      await blocked;
      await waiter?.rollback();
    }
  }
}

describe('lock helpers are scoped to this run’s database', () => {
  it('a lock wait and a record lock in another database are not counted', async () => {
    await db.raw('DROP DATABASE IF EXISTS ??', [OTHER]);
    try {
      await db.raw('CREATE DATABASE ??', [OTHER]);
      await db.raw('CREATE TABLE ??.notification_deliveries (id INT PRIMARY KEY) ENGINE=InnoDB', [OTHER]);
      await db.raw('INSERT INTO ??.notification_deliveries (id) VALUES (1)', [OTHER]);
      await withLockWait(OTHER, 'notification_deliveries', 1, async () => {
        expect(await waitsIn(OTHER)).toBeGreaterThan(0);
        expect(await lockWaits(db)).toBe(0);
        expect(await ownLocks(db)).toEqual([]);
      });
    } finally {
      await db.raw('DROP DATABASE IF EXISTS ??', [OTHER]);
    }
  });

  it('a lock wait and a record lock in this database are counted', async () => {
    const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    await withLockWait(testConfig().dbName, 'notifications', n.id, async () => {
      expect(await lockWaits(db)).toBe(1);
      const locks = await ownLocks(db);
      expect(locks.some((l) => l.table === 'notifications' && l.type === 'RECORD' && /^X/.test(l.mode))).toBe(
        true,
      );
    });
  });
});
