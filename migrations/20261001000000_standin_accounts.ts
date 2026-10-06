// STAND-IN (temporary, §5.9). Creates accounts only when STANDINS=true (otherwise requires it to exist); orders before the initial migration so the delivery FK can reference accounts.
import type { Knex } from 'knex';
export async function up(knex: Knex) {
  // Gate on STANDINS alone (not the whole app config), so unrelated env vars cannot break a migration run.
  if (process.env.STANDINS !== 'true') {
    // Production path: the real accounts table must already exist. Failing here (rather than recording a no-op and
    // letting the initial migration fail on the delivery FK) leaves the database unmigrated and recoverable.
    if (await knex.schema.hasTable('accounts')) return;
    throw new Error(
      'accounts table missing: set STANDINS=true for development/test; in production the table must already exist',
    );
  }
  if (process.env.NODE_ENV === 'production') throw new Error('STANDINS=true is refused in production');
  if (await knex.schema.hasTable('accounts'))
    throw new Error('accounts already exists; the stand-in refuses to replace it');
  await knex.raw(`CREATE TABLE accounts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, country VARCHAR(2) NOT NULL, policy VARCHAR(16) NOT NULL,
  relationship_status VARCHAR(16) NOT NULL, credits INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
}
export async function down() {
  throw new Error('forward-only');
}
