// Housekeeping timer (§8.3): recovery paths and retention, every HOUSEKEEPING_CRON on the leader.
import type { Deps } from '../lib/deps.js';
import type { Timer } from './index.js';
import { cronSchedule } from './schedule.js';
import { cancelledScheduledDeliveries } from '../lib/cancellation.js';
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
    for (const notificationId of ids) await queue.enqueue('fanout_filter', { notificationId });
    if (ids.length < chunk) break;
    afterId = ids[ids.length - 1]!;
  }

  for (;;) {
    const ids: number[] = await cancelledScheduledDeliveries(db).limit(chunk).pluck('d.id');
    if (ids.length === 0) break;
    await db('notification_deliveries').whereIn('id', ids).del();
    if (ids.length < chunk) break;
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
  for (const s of stale) await queue.enqueue('process_import', { importId: s.importId, runId: s.runId });

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

/**
 * §11.4 abuse signal: deliveries created today (UTC, from the injected clock) per account — max and p99 (nearest rank).
 * notification_deliveries has no created_at index and no migration is added, so the first id created today is found by
 * a binary search over the primary key (created_at rises with id; ~log2(rows) point lookups), then only today's id
 * range is scanned and grouped by account. Cost is proportional to today's deliveries, not the table.
 */
export async function deliveriesPerAccountDay(deps: Pick<Deps, 'db' | 'clock' | 'metrics'>): Promise<void> {
  const { db, clock, metrics } = deps;
  const now = clock.now();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [bounds] = await db('notification_deliveries').min({ lo: 'id' }).max({ hi: 'id' });
  let max = 0;
  let p99 = 0;
  if (bounds?.lo != null) {
    let lo = Number(bounds.lo);
    let hi = Number(bounds.hi) + 1; // first id with created_at >= dayStart lies in [lo, hi]
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
    const counts: number[] = (
      await db('notification_deliveries')
        .select('account_id')
        .count({ c: '*' })
        .where('id', '>=', lo)
        .andWhere('created_at', '>=', dayStart)
        .groupBy('account_id')
    )
      .map((r) => Number(r.c))
      .sort((a, b) => a - b);
    if (counts.length > 0) {
      max = counts[counts.length - 1] ?? 0;
      p99 = counts[Math.ceil(0.99 * counts.length) - 1] ?? 0;
    }
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
