import type { Knex } from 'knex';
/**
 * Lock probes for tests. performance_schema's lock tables are server-wide and other test runs share the server
 * (each in its own database), so every probe here is restricted to this connection's database: DATABASE().
 */

/** Lock waits in progress whose REQUESTING lock is on a table in this run's database. */
export const lockWaits = async (db: Knex) =>
  Number(
    (
      await db.raw(
        `SELECT COUNT(*) AS c FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
         WHERE l.OBJECT_SCHEMA = DATABASE()`,
      )
    )[0][0].c,
  );

export type OwnLock = { table: string; type: 'TABLE' | 'RECORD'; mode: string; index: string | null };
/** Every lock currently held or requested on a table in this run's database, optionally on one table only. */
export const ownLocks = async (db: Knex, table?: string): Promise<OwnLock[]> =>
  (
    await db.raw(
      `SELECT OBJECT_NAME AS \`table\`, LOCK_TYPE AS type, LOCK_MODE AS mode, INDEX_NAME AS \`index\`
       FROM performance_schema.data_locks
       WHERE OBJECT_SCHEMA = DATABASE() AND (? IS NULL OR OBJECT_NAME = ?)`,
      [table ?? null, table ?? null],
    )
  )[0];

/** Record locks currently on `table` in this run's database. */
export const recordLocks = async (db: Knex, table: string) =>
  (await ownLocks(db, table)).filter((l) => l.type === 'RECORD');
