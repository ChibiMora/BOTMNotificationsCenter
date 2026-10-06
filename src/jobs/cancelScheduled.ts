// `cancel_scheduled` job handler (§7.4, §8.2): early cleanup of one notification's cancelled scheduled deliveries.
// Cleanup only: due-send enforces cancellation at release time and housekeeping is the safety net. Live rows and
// scheduled rows that are not cancelled under the shared rule are never touched.
//
// Locking. Each chunk is one short transaction: a non-locking candidate read, then the candidate rows locked by
// primary key FOR UPDATE SKIP LOCKED (rows held by a due-send batch, a member click or an account cascade are skipped,
// never waited for), then a DELETE of exactly the locked ids with the rule re-checked in the statement. The DELETE's
// EXISTS takes a momentary SHARED record lock on the notification row (measured: InnoDB takes it even under READ
// COMMITTED and optimizer hints do not avoid it); an admin deactivate/remove taking FOR UPDATE NOWAIT at that instant
// gets a retryable 409. The job never waits while holding it: every delivery row it deletes is already locked by it,
// and the commit right after the DELETE releases it. Skipped rows are left to a later run, due-send or housekeeping.
import { CANCELLED_SQL, cancelledScheduledDeliveries } from '../lib/cancellation.js';
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';

const CHUNK = 5_000;

const placeholders = (ids: readonly number[]) => ids.map(() => '?').join(', ');

/** Deletes in chunks of `chunk` until none remain or no progress is possible; heartbeats between chunks. */
export async function cancelScheduledRun(
  deps: Deps,
  notificationId: number,
  ctx: JobContext,
  chunk = CHUNK,
): Promise<number> {
  let total = 0;
  for (;;) {
    const ids: number[] = await cancelledScheduledDeliveries(deps.db)
      .where('d.notification_id', notificationId)
      .limit(chunk)
      .pluck('d.id');
    if (ids.length === 0) break;
    const deleted = await deps.db.transaction(async (trx) => {
      const [locked] = (await trx.raw(
        `SELECT id FROM notification_deliveries WHERE id IN (${placeholders(ids)}) FOR UPDATE SKIP LOCKED`,
        ids,
      )) as [Array<{ id: number }>];
      if (locked.length === 0) return 0;
      const lockedIds = locked.map((r) => Number(r.id));
      // Re-checked through the rule: a row that stopped being cancelled since the candidate read survives.
      const [result] = await trx.raw(
        `DELETE FROM notification_deliveries AS d
         WHERE d.id IN (${placeholders(lockedIds)}) AND d.sent_at IS NULL
           AND EXISTS (SELECT 1 FROM notifications n WHERE n.id = d.notification_id AND ${CANCELLED_SQL})`,
        lockedIds,
      );
      const count = Number(result?.affectedRows);
      if (!Number.isFinite(count)) throw new Error('cancel_scheduled delete returned no affected-row count');
      return count;
    });
    total += deleted;
    // A short candidate read was the last chunk. A full chunk with nothing deleted (all locked elsewhere, or no longer
    // cancelled) ends this run: never loop on the same ids.
    if (ids.length < chunk || deleted === 0) break;
    await ctx.heartbeat();
  }
  deps.metrics.count('cancel_scheduled_deleted', total);
  deps.log.info({ notificationId, deleted: total }, 'cancel_scheduled done');
  return total;
}

export const cancelScheduled: (
  deps: Deps,
  payload: JobPayloads['cancel_scheduled'],
  ctx: JobContext,
) => Promise<void> = async (deps, { notificationId }, ctx) => {
  await cancelScheduledRun(deps, notificationId, ctx);
};
