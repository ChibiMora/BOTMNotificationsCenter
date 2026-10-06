import { fileURLToPath } from 'node:url';
import knexLib, { type Knex } from 'knex';
import type { Config } from '../config/index.js';
const SESSION_SQL =
  "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,ONLY_FULL_GROUP_BY,TIME_TRUNCATE_FRACTIONAL', SESSION transaction_isolation = 'READ-COMMITTED', SESSION time_zone = '+00:00'";
/** New knex pool (§5): mysql2, UTC (driver and session time_zone), strict SQL mode, READ COMMITTED. No singleton —
 *  callers own and destroy it.
 *
 *  sql_mode includes TIME_TRUNCATE_FRACTIONAL: fractional seconds written to a DATETIME column are truncated to the
 *  whole second below (MySQL's default rounds to the nearest), so every write on this pool matches the
 *  application's whole-second timestamps.
 *
 *  FOUND_ROWS is disabled ('-FOUND_ROWS'): `update()` and affectedRows report rows CHANGED, not rows matched. An
 *  update that matches a row but writes identical values returns 0, so callers must not treat 0 as "not found".
 *  insertDeliveries relies on this: with ON DUPLICATE KEY UPDATE id = id a duplicate counts 0, a new row 1. */
export function createDb(url: string, opts: { pool?: Knex.PoolConfig } = {}): Knex {
  return knexLib({
    client: 'mysql2',
    connection: {
      uri: url,
      timezone: 'Z',
      dateStrings: false,
      supportBigNumbers: true,
      flags: '-FOUND_ROWS',
    } as any,
    pool: {
      min: 0,
      max: 10,
      ...opts.pool,
      afterCreate: (conn: any, done: (e: Error | null, c: unknown) => void) =>
        conn.query(SESSION_SQL, (e: Error | null) => done(e, conn)),
    },
  });
}
export const createWriterDb = (c: Config) => createDb(c.databaseUrl);
export const createReaderDb = (c: Config) => createDb(c.databaseReaderUrl);
export const withTransaction = <T>(db: Knex, fn: (trx: Knex.Transaction) => Promise<T>) => db.transaction(fn);
export const MIGRATIONS = {
  directory: fileURLToPath(new URL('../../migrations', import.meta.url)),
  loadExtensions: ['.ts', '.js'],
};
