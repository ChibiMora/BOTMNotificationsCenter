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
export async function resetDb(db: Knex) {
  const hasJobs = await db.schema.hasTable('jobs');
  await db.transaction(async (trx) => {
    await trx.raw('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const t of OWNED) {
        await trx.raw('TRUNCATE TABLE ??', [t]);
      }
      if (hasJobs) {
        await trx.raw('TRUNCATE TABLE jobs');
      }
    } finally {
      await trx.raw('SET FOREIGN_KEY_CHECKS = 1');
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
