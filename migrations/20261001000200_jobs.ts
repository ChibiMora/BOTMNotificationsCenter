// Stand-in queue table (§5.7). Own migration so it can be dropped when the real queue adapter lands.
import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.raw(`CREATE TABLE jobs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type        VARCHAR(32) NOT NULL,
  payload     JSON NOT NULL,
  run_at      DATETIME NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  status      ENUM('queued','running','done','dead') NOT NULL DEFAULT 'queued',
  locked_by   VARCHAR(64) NULL,
  locked_at   DATETIME NULL,
  last_error  TEXT NULL,
  created_at  DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  KEY idx_jobs_claim (status, run_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
}

export async function down() {
  throw new Error('forward-only');
}
