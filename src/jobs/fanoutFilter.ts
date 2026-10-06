/**
 * `fanout_filter` job handler (§7.2 steps 5–7, §8.2): sends an active filter notification to every eligible account,
 * once per UTC month, in account-id ranges of 10,000. Idempotent and safe to run concurrently (B8, B17).
 */
import type { Knex } from 'knex';
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';
import type { NotificationRow } from '../lib/rows.js';
import {
  eligibleAccounts,
  idBetween,
  nextAccountId,
  notYetDelivered,
  UnusableFiltersError,
} from '../eligibility/buildQuery.js';
import { activeFilterNotifications } from '../lib/filterNotifications.js';
import { insertDeliveries } from '../lib/insertDeliveries.js';
import { monthKey } from '../lib/time.js';

/** Account ids read per page (§8.2: `a.id BETWEEN :lo AND :lo + 9999`). */
export const ID_RANGE = 10_000;

/** The notification if it is a filter notification that is active and not removed, else undefined. */
export async function activeFilterNotification(db: Knex, id: number): Promise<NotificationRow | undefined> {
  return activeFilterNotifications(db).where('n.id', id).first('n.*');
}

export const fanoutFilter: (
  deps: Deps,
  payload: JobPayloads['fanout_filter'],
  ctx: JobContext,
) => Promise<void> = async (deps, payload, ctx) => {
  const { notificationId } = payload;
  const notification = await activeFilterNotification(deps.db, notificationId);
  if (!notification) {
    deps.log.info(
      { notificationId, requestId: payload.requestId },
      'fanout_filter: not an active filter notification',
    );
    return;
  }
  const jobMonth = monthKey(deps.clock.now());
  // Throws UnusableFiltersError on malformed filters: the job is retried and finally dead-lettered (the alarm). Such a
  // notification stays active and is re-enqueued by every rescan, so each attempt fails fast and says why: ids only,
  // never the filters' content.
  try {
    eligibleAccounts(deps.dbReader, notification.filters);
  } catch (err) {
    if (err instanceof UnusableFiltersError) {
      deps.metrics.count('fanout_filter_unusable_filters');
      deps.log.error(
        { notificationId, requestId: payload.requestId },
        'fanout_filter: unusable filters, notification cannot be sent',
      );
    }
    throw err;
  }
  let written = 0;
  let stopped = 'done';
  // Each range starts at the lowest existing id at or above the cursor, so empty stretches of a sparse id space cost
  // nothing, and accounts created during the run above the ids seen so far are reached when the loop gets there.
  for (let next = 1; ;) {
    const lo = await nextAccountId(deps.dbReader, next);
    if (lo === undefined) {
      break;
    }
    const t = deps.clock.now();
    if (monthKey(t) !== jobMonth) {
      stopped = 'month changed';
      break;
    }
    const query = notYetDelivered(
      eligibleAccounts(deps.dbReader, notification.filters),
      notificationId,
      jobMonth,
    );
    const accounts: Array<{ id: number }> = await idBetween(query, lo, lo + ID_RANGE - 1);
    let deactivated = false;
    for (let i = 0; i < accounts.length; i += deps.config.fanoutBatchSize) {
      // Re-checked on the writer (must be current) right before each chunk's insert, so a deactivation or removal
      // committed since the previous check stops the job within one chunk.
      if (!(await activeFilterNotification(deps.db, notificationId))) {
        deactivated = true;
        break;
      }
      // `now` is taken per chunk on purpose: created_at must be fresh for the cancellation rule. At a month boundary
      // a chunk can therefore carry a created_at in the new month under the old month key, with sent_at in the old one.
      const chunk = accounts.slice(i, i + deps.config.fanoutBatchSize).map((a) => ({
        notificationId,
        accountId: a.id,
        dedupeKey: jobMonth,
        dueAt: t,
        sentAt: t,
      }));
      const result = await insertDeliveries(deps.db, chunk, { now: deps.clock.now() });
      written += result.inserted;
    }
    next = lo + ID_RANGE;
    if (deactivated || !(await activeFilterNotification(deps.db, notificationId))) {
      stopped = 'deactivated or removed';
      break;
    }
    await ctx.heartbeat();
  }
  deps.metrics.count('fanout_filter_deliveries_written', written);
  deps.log.info(
    { notificationId, jobMonth, written, stopped, requestId: payload.requestId },
    'fanout_filter finished',
  );
};
