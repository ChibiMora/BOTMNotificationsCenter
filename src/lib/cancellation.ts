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
export function whereCancelledScheduled(qb: Knex.QueryBuilder): Knex.QueryBuilder {
  return qb.whereNull('d.sent_at').andWhereRaw(CANCELLED_SQL);
}
/** Base query selecting nothing yet: d JOIN n restricted to cancelled scheduled rows. */
export const cancelledScheduledDeliveries = (db: Knex) =>
  whereCancelledScheduled(
    db('notification_deliveries as d').join('notifications as n', 'n.id', 'd.notification_id'),
  );
