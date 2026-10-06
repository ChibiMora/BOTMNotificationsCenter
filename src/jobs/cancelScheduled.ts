// `cancel_scheduled` job handler (§7.4, §8.2): early cleanup of one notification's cancelled scheduled deliveries.
// Cleanup only: due-send enforces cancellation at release time and housekeeping is the safety net. Live rows and
// scheduled rows that are not cancelled under the shared rule are never touched.
//
// Paging. Candidates are read in id order, each chunk continuing after the highest id the previous chunk read, so a
// run visits every cancelled row of the notification at most once and is bounded by one pass over them. Rows skipped
// because they were locked elsewhere are simply left for a later run, due-send or housekeeping.
//
// Locking. Each chunk is one short transaction: a non-locking candidate read (outside it), then inside it
//   1. a SHARED lock on the notification row, FOR SHARE NOWAIT. If an admin transaction holds that row (FOR UPDATE,
//      uncommitted) the chunk does not wait: the statement fails at once (errno 3572), the run ends quietly (logged,
//      counted as `cancel_scheduled_contended`) holding nothing, and due-send / housekeeping finish the cleanup;
//   2. the candidate rows locked by primary key FOR UPDATE SKIP LOCKED (rows held by a due-send batch, a member click
//      or an account cascade are skipped, never waited for);
//   3. a DELETE of exactly those locked ids with the rule re-checked in the statement; its EXISTS needs the shared
//      notification lock the chunk already holds, so it cannot wait either.
// So the job never waits on a lock. It holds the shared notification lock and up to one chunk of delivery-row
// exclusive locks only from step 1 to the chunk's commit; an admin deactivate/remove taking FOR UPDATE NOWAIT inside
// that window gets a retryable 409.
import { CANCELLED_SQL, cancelledScheduledDeliveries } from '../lib/cancellation.js';
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';

const CHUNK = 5_000;
const ER_LOCK_NOWAIT = 3572;
const CONTENDED = Symbol('contended');

const placeholders = (ids: readonly number[]) => ids.map(() => '?').join(', ');

/** Deletes in id-ordered chunks of `chunk` over one pass of the candidates; heartbeats between chunks. */
export async function cancelScheduledRun(
  deps: Deps,
  notificationId: number,
  ctx: JobContext,
  chunk = CHUNK,
): Promise<number> {
  let total = 0;
  let lastId = 0;
  for (;;) {
    const ids: number[] = (
      await cancelledScheduledDeliveries(deps.db)
        .where('d.notification_id', notificationId)
        .andWhere('d.id', '>', lastId)
        .orderBy('d.id')
        .limit(chunk)
        .pluck('d.id')
    ).map(Number);
    if (ids.length === 0) break;
    lastId = ids[ids.length - 1]!;
    const deleted = await deps.db.transaction(async (trx) => {
      try {
        await trx.raw('SELECT 1 FROM notifications WHERE id = ? FOR SHARE NOWAIT', [notificationId]);
      } catch (err) {
        if ((err as { errno?: unknown })?.errno === ER_LOCK_NOWAIT) return CONTENDED;
        throw err;
      }
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
    if (deleted === CONTENDED) {
      deps.log.info(
        { notificationId },
        'cancel_scheduled: notification row locked elsewhere, run ended early',
      );
      deps.metrics.count('cancel_scheduled_contended', 1);
      break;
    }
    total += deleted;
    // A short candidate read was the last chunk; otherwise continue after lastId (never re-reading earlier ids).
    if (ids.length < chunk) break;
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
