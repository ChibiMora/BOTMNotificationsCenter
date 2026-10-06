// Housekeeping timer (§8.3): recovery paths and retention, every HOUSEKEEPING_CRON on the leader.
import type { Deps } from '../lib/deps.js';
import type { JobPayloads, JobType } from '../queue/queue.js';
import type { Timer } from './index.js';
import { cronSchedule } from './schedule.js';
import { CONTENDED, cancelledScheduledDeliveries, deleteCancelledLocked } from '../lib/cancellation.js';
import { monthKey } from '../lib/time.js';
import { activeFilterNotifications } from '../lib/filterNotifications.js';

const CHUNK = 1000;
const STALE_IMPORT_MS = 10 * 60_000;
const FAILED_IMPORT_FILE_DAYS = 30;
const DAY_MS = 86_400_000;

export interface HousekeepingOptions {
  /** Rows per scan chunk (tests use a small one). */
  chunk?: number;
}

/** Each enqueue is caught on its own (as rescan does): one failure is counted and logged, the rest still run. */
async function enqueueOne<T extends JobType>(deps: Deps, type: T, payload: JobPayloads[T]): Promise<void> {
  try {
    await deps.queue.enqueue(type, payload);
  } catch (err) {
    deps.metrics.count('housekeeping_enqueue_failed', 1, { type });
    deps.log.error({ err, type, payload: payload as object }, 'housekeeping: enqueue failed');
  }
}

export async function housekeeping(deps: Deps, opts: HousekeepingOptions = {}): Promise<void> {
  const { db, clock, queue } = deps;
  const now = clock.now();
  const chunk = opts.chunk ?? CHUNK;

  // Active filter notifications with no delivery this month, in id-ordered chunks (keyset on n.id). This relies on
  // fanout_filter being idempotent. By design, a notification whose audience is empty never gets a delivery and is
  // therefore re-enqueued on every run.
  for (let afterId = 0; ;) {
    const ids: number[] = await activeFilterNotifications(db)
      .andWhere('n.id', '>', afterId)
      .whereNotExists(
        db('notification_deliveries as d')
          .whereRaw('d.notification_id = n.id')
          .andWhere('d.dedupe_key', monthKey(now)),
      )
      .orderBy('n.id')
      .limit(chunk)
      .pluck('n.id');
    for (const notificationId of ids) await enqueueOne(deps, 'fanout_filter', { notificationId });
    if (ids.length < chunk) break;
    afterId = ids[ids.length - 1]!;
  }

  // Same locked delete as cancel_scheduled, per notification; keyset on d.id so skipped (locked) rows end the scan.
  for (let afterId = 0; ;) {
    const rows: Array<{ id: number; notificationId: number }> = await cancelledScheduledDeliveries(db)
      .andWhere('d.id', '>', afterId)
      .orderBy('d.id')
      .limit(chunk)
      .select('d.id as id', 'd.notification_id as notificationId');
    if (rows.length === 0) break;
    const byNotification = new Map<number, number[]>();
    for (const r of rows) {
      const list = byNotification.get(Number(r.notificationId)) ?? [];
      list.push(Number(r.id));
      byNotification.set(Number(r.notificationId), list);
    }
    for (const [notificationId, ids] of byNotification) {
      const deleted = await deleteCancelledLocked(db, notificationId, ids);
      if (deleted === CONTENDED)
        deps.log.info(
          { notificationId },
          'housekeeping: notification row locked elsewhere, cancelled rows skipped',
        );
    }
    if (rows.length < chunk) break;
    afterId = Number(rows[rows.length - 1]!.id);
  }

  const stale = await db('imports as i')
    .where('i.status', 'processing')
    .andWhere('i.updated_at', '<', new Date(now.getTime() - STALE_IMPORT_MS))
    .join(
      db('import_runs').select('import_id').max('id as run_id').groupBy('import_id').as('r'),
      'r.import_id',
      'i.id',
    )
    .select('i.id as importId', 'r.run_id as runId');
  for (const s of stale) await enqueueOne(deps, 'process_import', { importId: s.importId, runId: s.runId });

  await db('import_files')
    .whereIn(
      'import_id',
      db('imports')
        .select('id')
        .where('status', 'failed')
        .andWhere('updated_at', '<', new Date(now.getTime() - FAILED_IMPORT_FILE_DAYS * DAY_MS)),
    )
    .del();

  const purgeable = queue as Partial<{ purgeDead(): Promise<number> }>;
  if (typeof purgeable.purgeDead === 'function') await purgeable.purgeDead();
}

export const housekeepingTimer = (deps: Deps): Timer => ({
  name: 'housekeeping',
  leaderOnly: true,
  schedule: cronSchedule(deps.config.housekeepingCron),
  run: (d) => housekeeping(d),
});
