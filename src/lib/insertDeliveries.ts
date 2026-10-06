// The ONLY delivery insert path (§5.3). ON DUPLICATE KEY UPDATE id = id; never INSERT IGNORE.
import type { Knex } from 'knex';
import { newPublicId } from './publicId.js';
export interface NewDelivery {
  notificationId: number;
  accountId: number;
  dedupeKey: string;
  dueAt: Date;
  sentAt?: Date | null;
  occurrenceKey?: string | null;
}
export interface InsertResult {
  inserted: number;
  alreadyDelivered: number;
  /** DISTINCT account ids that do not exist; several rows may have been dropped per id. */
  unknownAccounts: number[];
}
const FK_ERR = 1452;
const key = (r: { notification_id: number; account_id: number; dedupe_key: string }) =>
  `${r.notification_id}|${r.account_id}|${r.dedupe_key}`;

/**
 * Insert delivery rows idempotently. `now` comes from the application Clock and is written as `created_at` (whole
 * seconds) on every row, because the cancellation rule (§7.4) compares `created_at` with `cancelled_before`, which is
 * also written from the Clock. Callers pass batches of at most ~1,000 rows (the configured batch/chunk sizes); this
 * helper sends each call as one multi-row INSERT and does no chunking of its own.
 */
export async function insertDeliveries(
  db: Knex,
  rows: NewDelivery[],
  opts: { now: Date; newId?: () => string },
): Promise<InsertResult> {
  const newId = opts.newId ?? newPublicId;
  const createdAt = new Date(Math.floor(opts.now.getTime() / 1000) * 1000);
  const unknownAccounts: number[] = [];
  let inserted = 0;
  let droppedUnknown = 0;
  let pending = rows.map((r) => ({
    notification_id: r.notificationId,
    account_id: r.accountId,
    dedupe_key: r.dedupeKey,
    due_at: r.dueAt,
    sent_at: r.sentAt ?? null,
    occurrence_key: r.occurrenceKey ?? null,
    created_at: createdAt,
  }));
  for (let round = 0; pending.length > 0; round++) {
    if (round > 10) throw new Error('insertDeliveries: public_id clashes did not resolve');
    const batch = pending.map((r) => ({ ...r, public_id: newId() }));
    const q = db('notification_deliveries').insert(batch).toSQL().toNative();
    let affected: number;
    try {
      affected = (await db.raw(`${q.sql} ON DUPLICATE KEY UPDATE id = id`, q.bindings as any))[0]
        .affectedRows;
    } catch (e: any) {
      if (e?.errno !== FK_ERR || !String(e.message).includes('fk_delivery_account')) throw e;
      const ids = [...new Set(pending.map((r) => r.account_id))];
      const existing = new Set((await db('accounts').whereIn('id', ids).pluck('id')).map(Number));
      const missing = ids.filter((id) => !existing.has(id));
      if (missing.length === 0) throw e;
      unknownAccounts.push(...missing);
      const kept = pending.filter((r) => existing.has(r.account_id));
      droppedUnknown += pending.length - kept.length;
      pending = kept;
      continue;
    }
    inserted += affected;
    if (affected === batch.length) break;
    // Fewer inserted than sent: repeats or public_id clashes. Re-read which triples now exist; the missing ones clashed.
    const present = new Set(
      (
        await db('notification_deliveries')
          .select('notification_id', 'account_id', 'dedupe_key')
          .whereIn(
            ['notification_id', 'account_id', 'dedupe_key'],
            pending.map((r) => [r.notification_id, r.account_id, r.dedupe_key]),
          )
      ).map(key),
    );
    pending = pending.filter((r) => !present.has(key(r)));
  }
  return { inserted, alreadyDelivered: rows.length - droppedUnknown - inserted, unknownAccounts };
}
