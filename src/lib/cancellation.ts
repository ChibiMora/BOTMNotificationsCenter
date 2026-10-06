// The single definition of "this scheduled delivery is cancelled" (§7.4). Shared by due-send, cancel_scheduled and housekeeping.
// The rule compares d.created_at with n.cancelled_before, so both must come from the same (application) clock:
// - callers must write `cancelled_before` from the application clock (clock.now()), never the database's NOW();
// - callers must pass a FRESH clock.now() as `now` to every insertDeliveries call. A `now` captured at job start
//   could stamp rows inserted after a reactivation with a created_at at or before the new cancelled_before,
//   marking them cancelled.
import type { Knex } from 'knex';
/**
 * The rule as raw SQL over aliases `d` (notification_deliveries) and `n` (notifications), for an unsent row.
 * `active`, `removed` and `created_at` are NOT NULL, so NOT_CANCELLED_SQL is the exact negation of CANCELLED_SQL.
 * Used directly by due-send and cancel_scheduled inside non-locking EXISTS subqueries.
 */
export const CANCELLED_SQL =
  '(n.removed = TRUE OR n.active = FALSE OR (n.cancelled_before IS NOT NULL AND d.created_at <= n.cancelled_before))';
export const NOT_CANCELLED_SQL =
  '(n.active = TRUE AND n.removed = FALSE AND (n.cancelled_before IS NULL OR d.created_at > n.cancelled_before))';
/** Query modifier over `notification_deliveries as d` JOIN `notifications as n`. */
function whereCancelledScheduled(qb: Knex.QueryBuilder): Knex.QueryBuilder {
  return qb.whereNull('d.sent_at').andWhereRaw(CANCELLED_SQL);
}
/** Base query selecting nothing yet: d JOIN n restricted to cancelled scheduled rows. */
export const cancelledScheduledDeliveries = (db: Knex) =>
  whereCancelledScheduled(
    db('notification_deliveries as d').join('notifications as n', 'n.id', 'd.notification_id'),
  );

const ER_LOCK_NOWAIT = 3572;
/** Returned by deleteCancelledLocked when another transaction holds the notification row. */
export const CONTENDED = Symbol('contended');

const placeholders = (ids: readonly number[]) => ids.map(() => '?').join(', ');

/**
 * The one locked delete of cancelled scheduled deliveries (§7.4, §8.3), shared by cancel_scheduled and housekeeping.
 * `ids` are candidates of ONE notification from a non-locking read. In one transaction:
 *   1. the notification row FOR SHARE NOWAIT: a concurrent admin write (e.g. re-activation) returns CONTENDED;
 *   2. the candidate rows FOR UPDATE SKIP LOCKED (rows held by a due-send batch or a member action are left);
 *   3. delete of the locked rows with the rule re-checked, so a row that stopped being cancelled survives.
 * Returns the number of rows deleted, or CONTENDED.
 */
export async function deleteCancelledLocked(
  db: Knex,
  notificationId: number,
  ids: readonly number[],
): Promise<number | typeof CONTENDED> {
  if (ids.length === 0) return 0;
  return db.transaction(async (trx) => {
    try {
      await trx.raw('SELECT 1 FROM notifications WHERE id = ? FOR SHARE NOWAIT', [notificationId]);
    } catch (err) {
      if ((err as { errno?: unknown })?.errno === ER_LOCK_NOWAIT) return CONTENDED;
      throw err;
    }
    const [locked] = (await trx.raw(
      `SELECT id FROM notification_deliveries WHERE id IN (${placeholders(ids)}) AND notification_id = ? FOR UPDATE SKIP LOCKED`,
      [...ids, notificationId],
    )) as [Array<{ id: number }>];
    if (locked.length === 0) return 0;
    const lockedIds = locked.map((r) => Number(r.id));
    const [result] = await trx.raw(
      `DELETE FROM notification_deliveries AS d
       WHERE d.id IN (${placeholders(lockedIds)}) AND d.sent_at IS NULL
         AND EXISTS (SELECT 1 FROM notifications n WHERE n.id = d.notification_id AND ${CANCELLED_SQL})`,
      lockedIds,
    );
    const count = Number(result?.affectedRows);
    if (!Number.isFinite(count)) throw new Error('cancelled-delivery delete returned no affected-row count');
    return count;
  });
}
