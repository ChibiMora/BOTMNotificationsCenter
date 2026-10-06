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

  // A metrics failure is logged, never fails the housekeeping run.
  await deliveriesPerAccountDay(deps).catch((e) =>
    deps.log.error({ err: e }, 'deliveries per account metric failed'),
  );
}

/** Ids by which a delivery created today may precede an earlier-created one: concurrent writers allocate ids and
 *  stamp created_at in different orders (a long fan-out insert that read the clock before midnight commits ids above
 *  rows stamped after it). 100k ids covers far more than any single open insert batch, and costs at most 100k extra
 *  primary-key rows in the scan; `created_at >= dayStart` inside the range keeps the count exact. */
const DAY_START_ID_MARGIN = 100_000;
/** Time budget (MySQL MAX_EXECUTION_TIME hint) for the aggregate query; over it the gauges are skipped this run. */
const DELIVERIES_PER_ACCOUNT_DAY_BUDGET_MS = 5000;
const ER_QUERY_TIMEOUT = 3024;

/**
 * §11.4 abuse signal: deliveries created today (UTC, from the injected clock) per account — max and p99 (nearest rank).
 * Runs on the READER. notification_deliveries has no created_at index and no migration is added, so the first id
 * created today is approximated by a binary search over the primary key (~log2(rows) point lookups), started
 * DAY_START_ID_MARGIN ids earlier, and only that id range is scanned with `created_at >= dayStart`. Both numbers are
 * computed in SQL (per-account counts in a derived table, ranked with a window function) so one row comes back.
 * Over the time budget (ER_QUERY_TIMEOUT) the gauges are not emitted this run: warn + deliveries_per_account_day_skipped.
 */
export async function deliveriesPerAccountDay(
  deps: Pick<Deps, 'dbReader' | 'clock' | 'metrics' | 'log'>,
): Promise<void> {
  const { dbReader: db, clock, metrics, log } = deps;
  const now = clock.now();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [bounds] = await db('notification_deliveries').min({ lo: 'id' }).max({ hi: 'id' });
  let max = 0;
  let p99 = 0;
  if (bounds?.lo != null) {
    let lo = Number(bounds.lo);
    let hi = Number(bounds.hi) + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await db('notification_deliveries')
        .select('id', 'created_at')
        .where('id', '>=', mid)
        .orderBy('id')
        .first();
      if (!r || new Date(r.created_at).getTime() >= dayStart.getTime()) hi = mid;
      else lo = Number(r.id) + 1;
    }
    let rows: Array<{ max_n: unknown; p99_n: unknown }> | undefined;
    try {
      [rows] = await db.raw(
        `SELECT /*+ MAX_EXECUTION_TIME(${DELIVERIES_PER_ACCOUNT_DAY_BUDGET_MS}) */
           COALESCE(MAX(n), 0) AS max_n, COALESCE(MAX(CASE WHEN rn = CEIL(0.99 * total) THEN n END), 0) AS p99_n
         FROM (SELECT n, ROW_NUMBER() OVER (ORDER BY n) AS rn, COUNT(*) OVER () AS total
               FROM (SELECT account_id, COUNT(*) AS n FROM notification_deliveries
                     WHERE id >= ? AND created_at >= ? GROUP BY account_id) AS per_account) AS ranked`,
        [Math.max(0, lo - DAY_START_ID_MARGIN), dayStart],
      );
    } catch (e) {
      if ((e as { errno?: unknown }).errno !== ER_QUERY_TIMEOUT) throw e;
      log.warn({ err: e }, 'deliveries per account metric over its time budget; gauges skipped this run');
      metrics.count('deliveries_per_account_day_skipped');
      return;
    }
    max = Number(rows?.[0]?.max_n ?? 0);
    p99 = Number(rows?.[0]?.p99_n ?? 0);
  }
  metrics.gauge('deliveries_per_account_day_max', max);
  metrics.gauge('deliveries_per_account_day_p99', p99);
}

export const housekeepingTimer = (deps: Deps): Timer => ({
  name: 'housekeeping',
  leaderOnly: true,
  schedule: cronSchedule(deps.config.housekeepingCron),
  run: (d) => housekeeping(d),
});
