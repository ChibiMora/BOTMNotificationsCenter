// Initial schema (§5.2–§5.7) except jobs (created by 20261001000200_jobs). References accounts, never creates it (§5.8).
import type { Knex } from 'knex';
const TABLES = [
  `CREATE TABLE notification_types (
  id    TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name  VARCHAR(32) NOT NULL UNIQUE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  `CREATE TABLE notifications (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type           TINYINT UNSIGNED NOT NULL,
  image_key      VARCHAR(1024) NOT NULL,
  headline       VARCHAR(255)  NOT NULL,
  subheadline    VARCHAR(255)  NOT NULL,
  link_path      VARCHAR(2048) NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  removed        BOOLEAN NOT NULL DEFAULT FALSE,
  live_date      DATETIME NULL,
  delay          INT UNSIGNED NULL,
  event_trigger  VARCHAR(32) NULL,
  filters        JSON NULL,
  went_live_at   DATETIME NULL,
  cancelled_before DATETIME NULL,
  request_key    CHAR(36) NULL,
  request_endpoint VARCHAR(16) NULL,
  request_hash   CHAR(64) NULL,
  created_at     DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  CONSTRAINT fk_notifications_type FOREIGN KEY (type) REFERENCES notification_types(id),
  UNIQUE KEY uq_notifications_request_key (request_key),
  KEY idx_notifications_created (created_at, id),
  KEY idx_notifications_type_created (type, created_at, id),
  KEY idx_notifications_event (event_trigger, active)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  `CREATE TABLE notification_deliveries (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id        CHAR(15) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  notification_id INT UNSIGNED NOT NULL,
  account_id       INT UNSIGNED NOT NULL,
  is_clicked       BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at          DATETIME NULL,
  due_at           DATETIME NOT NULL,
  occurrence_key   VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  dedupe_key       VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  UNIQUE KEY uq_delivery_public (public_id),
  UNIQUE KEY uq_delivery_dedupe (notification_id, account_id, dedupe_key),
  KEY idx_member_list (account_id, sent_at, public_id),
  KEY idx_due_send (sent_at, due_at),
  KEY idx_by_notification (notification_id, sent_at),
  CONSTRAINT fk_delivery_notification FOREIGN KEY (notification_id) REFERENCES notifications(id),
  CONSTRAINT fk_delivery_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  `CREATE TABLE imports (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  notification_id   INT UNSIGNED NOT NULL,
  status             ENUM('processing','completed','failed') NOT NULL DEFAULT 'processing',
  updated_at         DATETIME NOT NULL,
  total_rows         INT UNSIGNED NOT NULL DEFAULT 0,
  accepted           INT UNSIGNED NOT NULL DEFAULT 0,
  duplicates_ignored INT UNSIGNED NOT NULL DEFAULT 0,
  request_key        CHAR(36) NOT NULL,
  request_hash       CHAR(64) NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  UNIQUE KEY uq_imports_request_key (request_key),
  CONSTRAINT fk_imports_notification FOREIGN KEY (notification_id) REFERENCES notifications(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  `CREATE TABLE import_runs (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  import_id   INT UNSIGNED NOT NULL,
  status      ENUM('processing','completed','failed') NOT NULL DEFAULT 'processing',
  started_at  DATETIME NOT NULL,
  finished_at DATETIME NULL,
  error       VARCHAR(255) NULL,
  request_key CHAR(36) NULL,
  UNIQUE KEY uq_import_runs_request_key (request_key),
  KEY idx_import_runs_import (import_id, id),
  CONSTRAINT fk_import_runs_import FOREIGN KEY (import_id) REFERENCES imports(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  `CREATE TABLE import_files (
  import_id  INT UNSIGNED PRIMARY KEY,
  data       MEDIUMBLOB NOT NULL,
  CONSTRAINT fk_import_files_import FOREIGN KEY (import_id) REFERENCES imports(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  `CREATE TABLE import_row_errors (
  import_id   INT UNSIGNED NOT NULL,
  row_num     INT UNSIGNED NOT NULL,
  account_id  BIGINT UNSIGNED NOT NULL,
  reason      VARCHAR(32) NOT NULL,
  PRIMARY KEY (import_id, row_num),
  CONSTRAINT fk_row_errors_import FOREIGN KEY (import_id) REFERENCES imports(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  `CREATE TABLE archived_notification_deliveries (
  id               BIGINT UNSIGNED PRIMARY KEY,
  public_id        CHAR(15) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  notification_id INT UNSIGNED NOT NULL,
  account_id       INT UNSIGNED NOT NULL,
  is_clicked       BOOLEAN NOT NULL,
  sent_at          DATETIME NOT NULL,
  due_at           DATETIME NOT NULL,
  occurrence_key   VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  dedupe_key       VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  created_at       DATETIME NOT NULL,
  archived_at      DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  KEY idx_archive_account (account_id),
  KEY idx_archive_notification (notification_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  `CREATE TABLE scheduled_runs (
  name              VARCHAR(32) PRIMARY KEY,
  last_started_at   DATETIME NULL,
  last_completed_at DATETIME NULL,
  last_status       VARCHAR(16) NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
];
export async function up(knex: Knex) {
  for (const sql of TABLES) await knex.raw(sql);
  await knex('notification_types').insert([{ name: 'filter' }, { name: 'event' }, { name: 'csv' }]);
  await knex('scheduled_runs').insert(
    ['rescan', 'due_send', 'expiry', 'housekeeping'].map((name) => ({ name })),
  );
}
export async function down() {
  throw new Error('forward-only');
}
