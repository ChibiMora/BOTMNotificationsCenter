import type { Knex } from 'knex';
import { loadConfig } from '../../src/config/index.js';
import { createWriterDb } from '../../src/db/index.js';
import { seedAccounts, SEED_ACCOUNTS } from '../../scripts/seedAccounts.js';
/** Config for tests: STANDINS on, database from DB_NAME. */
export const testConfig = () =>
  loadConfig({
    ASSET_BASE_URL: 'https://assets.example.com',
    SITE_BASE_URL: 'https://www.example.com',
    DATABASE_URL: 'mysql://root:root@127.0.0.1:3306/notification_center',
    ...process.env,
    STANDINS: 'true',
  });
export const testDb = () => createWriterDb(testConfig());
const OWNED = [
  'import_row_errors',
  'import_files',
  'import_runs',
  'imports',
  'archived_notification_deliveries',
  'notification_deliveries',
  'notifications',
];
/**
 * Reset to the seeded state: truncate owned tables (and `jobs` when it exists), null scheduled_runs bookkeeping
 * (its four rows stay), delete accounts with id > 72 and re-apply the 72 seeded rows. Runs on ONE connection so
 * FOREIGN_KEY_CHECKS is disabled and always restored on that same connection.
 */
export type LeakedTransaction = {
  thread: number;
  secondsOpen: number;
  state: string;
  command: string;
  lastStatement: string | null;
};
/**
 * Sessions of THIS database, other than the caller's, that sit idle (`Sleep`) holding an open transaction
 * (`secondsOpen` is how long it has sat idle in it, a lower bound on the transaction's age). A
 * per-database lock guarantees one test run per database, so any such session was leaked by this run.
 */
export async function leakedTransactions(db: Knex): Promise<LeakedTransaction[]> {
  // Not information_schema.innodb_trx: InnoDB serves that from a server-wide cache that is refreshed only after
  // 100 ms without readers, so a reader (this guard, or any other database's) within the last 100 ms makes a fresh
  // leak invisible and the reset then blocks on its locks. performance_schema's transaction view is live.
  const [rows] = await db.raw(
    `SELECT th.PROCESSLIST_ID AS thread, th.PROCESSLIST_TIME AS secondsOpen,
            e.STATE AS state, th.PROCESSLIST_COMMAND AS command
     FROM performance_schema.events_transactions_current e
     JOIN performance_schema.threads th ON th.THREAD_ID = e.THREAD_ID
     WHERE th.PROCESSLIST_DB = DATABASE() AND th.PROCESSLIST_ID <> CONNECTION_ID()
       AND e.STATE = 'ACTIVE' AND th.PROCESSLIST_COMMAND = 'Sleep'`,
  );
  const out: LeakedTransaction[] = [];
  for (const r of rows as Array<Omit<LeakedTransaction, 'lastStatement'>>) {
    let lastStatement: string | null = null;
    try {
      const [h] = await db.raw(
        `SELECT h.SQL_TEXT AS sql_text FROM performance_schema.events_statements_history h
         JOIN performance_schema.threads th ON th.THREAD_ID = h.THREAD_ID
         WHERE th.PROCESSLIST_ID = ? ORDER BY h.EVENT_ID DESC LIMIT 1`,
        [r.thread],
      );
      lastStatement = h[0]?.sql_text ?? null;
    } catch {
      // performance_schema unavailable: the thread id and age still identify the leak.
    }
    out.push({ ...r, thread: Number(r.thread), secondsOpen: Number(r.secondsOpen), lastStatement });
  }
  return out;
}
/** Seconds the reset's own session may wait for a metadata or row lock before failing (never the hook timeout). */
const RESET_LOCK_WAIT_SECONDS = 5;
/**
 * KILL returns before the victim finishes rolling back; until then it is still listed (COMMAND 'Killed') and still
 * holds its locks. Wait, bounded by RESET_LOCK_WAIT_SECONDS, until none of `threads` is a session of this database,
 * so the guard's "now killed" is true when it throws and the next reset does not race the rollback. Returns the
 * threads still listed when the bound ran out.
 */
async function awaitThreadsGone(db: Knex, threads: number[]): Promise<number[]> {
  const deadline = Date.now() + RESET_LOCK_WAIT_SECONDS * 1000;
  for (;;) {
    const [rows] = await db.raw(
      `SELECT ID AS id FROM information_schema.processlist WHERE DB = DATABASE() AND ID IN (${threads.map(() => '?').join(', ')})`,
      threads,
    );
    const left = (rows as Array<{ id: number }>).map((r) => Number(r.id));
    if (left.length === 0 || Date.now() >= deadline) return left;
    await new Promise((r) => setTimeout(r, 10));
  }
}
/**
 * Reset to the seeded state: truncate owned tables (and `jobs` when it exists), null scheduled_runs bookkeeping
 * (its four rows stay), delete accounts with id > 72 and re-apply the 72 seeded rows. Runs on ONE connection so
 * FOREIGN_KEY_CHECKS is disabled and always restored on that same connection.
 *
 * Guard: if another session of this database is idle holding an open transaction, the previous test leaked it.
 * Those sessions are killed (so the run cannot hang on a metadata lock) and this call throws naming them.
 */
export async function resetDb(db: Knex) {
  const leaked = await leakedTransactions(db);
  if (leaked.length > 0) {
    for (const l of leaked) {
      try {
        await db.raw('KILL ?', [l.thread]);
      } catch {
        // already gone (ER_NO_SUCH_THREAD): the leak is still reported below
      }
    }
    const survivors = await awaitThreadsGone(
      db,
      leaked.map((l) => l.thread),
    );
    const detail = leaked
      .map(
        (l) =>
          `thread ${l.thread}: open ${l.secondsOpen}s, state ${l.state}, last statement: ${l.lastStatement ?? 'unknown'}`,
      )
      .join('; ');
    const still = survivors.length > 0 ? ` (threads ${survivors.join(', ')} still rolling back)` : '';
    throw new Error(
      `resetDb: a transaction was leaked by the previous test (idle in transaction, now killed) — ${detail}${still}`,
    );
  }
  const hasJobs = await db.schema.hasTable('jobs');
  await db.transaction(async (trx) => {
    await trx.raw('SET SESSION lock_wait_timeout = ?, SESSION innodb_lock_wait_timeout = ?', [
      RESET_LOCK_WAIT_SECONDS,
      RESET_LOCK_WAIT_SECONDS,
    ]);
    await trx.raw('SET FOREIGN_KEY_CHECKS = 0');
    let failed = false;
    try {
      for (const t of OWNED) {
        await trx.raw('TRUNCATE TABLE ??', [t]);
      }
      if (hasJobs) {
        await trx.raw('TRUNCATE TABLE jobs');
      }
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      // A failed restore must not replace the TRUNCATE's own error (the connection may be the thing that died).
      try {
        await trx.raw('SET FOREIGN_KEY_CHECKS = 1');
        await trx.raw('SET SESSION lock_wait_timeout = DEFAULT, SESSION innodb_lock_wait_timeout = DEFAULT');
      } catch (e) {
        if (!failed) throw e;
      }
    }
  });
  await db('scheduled_runs').update({ last_started_at: null, last_completed_at: null, last_status: null });
  await db('accounts').where('id', '>', SEED_ACCOUNTS.length).delete();
  await seedAccounts(db, testConfig());
}
/** Change a stand-in account with a plain UPDATE (§5.9). */
export const updateAccount = (
  db: Knex,
  id: number,
  patch: Partial<{ country: string; policy: string; relationship_status: string; credits: number }>,
) => db('accounts').where({ id }).update(patch);
