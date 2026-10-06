// `due_send` timer (§7.4, §8.3 Due-send row; B10): releases due scheduled deliveries, deleting cancelled ones.
// Runs on EVERY worker. Each pass is one transaction over at most `dueSendBatch` delivery rows, selected through
// idx_due_send (sent_at, due_at) and locked FOR UPDATE SKIP LOCKED, so concurrent workers release disjoint rows and
// never block on each other or on notifications rows.
// Locks outside the delivery table (measured in performance_schema.data_locks): none on notifications, but one SHARED
// record lock (S,REC_NOT_GAP, PRIMARY) on the `accounts` row of each released delivery, held until commit. Cause: setting
// sent_at changes idx_member_list (account_id, sent_at, public_id), which contains the foreign-key column, so InnoDB
// re-checks the account FK and S-locks the parent row. Unavoidable without a schema change; bounded by the batch size
// (at most `dueSendBatch` account rows, never exclusive), released at commit; a write to one of those account rows
// (e.g. an account deletion cascade) waits for the batch to commit.
//
// Race with deactivate/remove: the release is ONE guarded UPDATE whose WHERE is "NOT cancelled", so the
// notification's state is read by the same statement that writes sent_at (no separate read to go stale).
// It is a correlated EXISTS, not UPDATE … JOIN: under READ COMMITTED the EXISTS reads notifications as a fresh
// statement-level consistent read with no locks, whereas the JOIN form holds S record locks on the notification
// rows until commit, which makes an admin's FOR UPDATE NOWAIT fail (measured in performance_schema.data_locks).
// Notifications rows are deliberately NOT locked FOR UPDATE: an admin deactivate/remove takes
// SELECT … FOR UPDATE NOWAIT on the notification and must never be blocked by due-send, and several workers must be
// able to release rows of the same notification in parallel.
// Residual window: a deactivation that commits AFTER the release statement has started cannot stop that one batch
// (at most `dueSendBatch` rows). Those rows carry a sent_at earlier than the deactivation, i.e. they are equivalent to
// a release that happened just before it; removal still hides them immediately because member reads check `removed`.
import type { Knex } from 'knex';
import { NOT_CANCELLED_SQL } from '../lib/cancellation.js';
import type { Deps } from '../lib/deps.js';
import type { Timer } from './index.js';
import { intervalSchedule } from './schedule.js';

/** One batch inside the caller's transaction; returns how many due rows it handled (released + deleted). */
export async function dueSendPass(deps: Deps, trx: Knex.Transaction): Promise<number> {
  const now = deps.clock.now();
  // (a) Lock this batch's due delivery rows only.
  const due: Array<{ id: number; due_at: Date }> = await trx
    .select('d.id', 'd.due_at')
    .from(trx.raw('?? FORCE INDEX (idx_due_send)', ['notification_deliveries as d']))
    .whereNull('d.sent_at')
    .andWhere('d.due_at', '<=', now)
    .limit(deps.config.dueSendBatch)
    .forUpdate()
    .skipLocked();
  if (due.length === 0) return 0;

  const ids = due.map((r) => r.id);
  const inList = ids.map(() => '?').join(', ');
  // (b) Decision and write in ONE statement: release only rows that are NOT cancelled at write time.
  const [released] = await trx.raw(
    `UPDATE notification_deliveries d SET d.sent_at = ?
     WHERE d.id IN (${inList}) AND d.sent_at IS NULL
       AND EXISTS (SELECT 1 FROM notifications n WHERE n.id = d.notification_id AND ${NOT_CANCELLED_SQL})`,
    [now, ...ids],
  );
  // (c) Every locked row still unsent is cancelled (or its notification row is missing): delete it so it is
  // never re-selected. The delivery rows are locked by this transaction, so nothing else changed them.
  const deleted = await trx('notification_deliveries').whereIn('id', ids).whereNull('sent_at').del();
  const releasedCount = Number(released.affectedRows);

  deps.metrics.count('due_send_released', releasedCount);
  deps.metrics.count('due_send_cancelled_deleted', deleted);
  if (releasedCount > 0) {
    const sentIds = new Set(
      (await trx('notification_deliveries').whereIn('id', ids).whereNotNull('sent_at').pluck('id')).map(
        Number,
      ),
    );
    const maxLagSeconds = Math.max(
      ...due
        .filter((r) => sentIds.has(Number(r.id)))
        .map((r) => (now.getTime() - new Date(r.due_at).getTime()) / 1000),
    );
    deps.metrics.gauge('due_send_lag_seconds', maxLagSeconds);
  }
  return releasedCount + deleted;
}

/** Runs on EVERY worker, every DUE_SEND_INTERVAL_SECONDS. */
export const dueSendTimer = (deps: Deps): Timer => ({
  name: 'due_send',
  leaderOnly: false,
  schedule: intervalSchedule(deps.config.dueSendIntervalSeconds),
  run: async (d) => {
    let handled: number;
    let total = 0;
    do {
      handled = await d.db.transaction((trx) => dueSendPass(d, trx));
      total += handled;
    } while (handled >= d.config.dueSendBatch);
    if (total > 0) d.log.info({ handled: total }, 'due_send done');
  },
});
