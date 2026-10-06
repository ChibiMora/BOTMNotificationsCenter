/**
 * `rescan` timer (§7.2 step 8, §8.3): enqueues `fanout_filter` for every active filter notification — the monthly
 * resend (B8) and the safety net for unreported account changes and lost enqueues. A failed enqueue is logged and skipped.
 */
import type { Deps } from '../lib/deps.js';
import type { Timer } from './index.js';
import { activeFilterNotifications } from '../lib/filterNotifications.js';
import { anyOf, cronSchedule, MONTH_START } from './schedule.js';

const PAGE = 500;

export async function rescan(deps: Deps, opts: { page?: number } = {}): Promise<void> {
  const page = opts.page ?? PAGE;
  let afterId = 0;
  let enqueued = 0;
  let failed = 0;
  for (;;) {
    const ids: number[] = await activeFilterNotifications(deps.db)
      .andWhere('n.id', '>', afterId)
      .orderBy('n.id')
      .limit(page)
      .pluck('n.id');
    for (const notificationId of ids) {
      try {
        await deps.queue.enqueue('fanout_filter', { notificationId });
        enqueued++;
      } catch (err) {
        failed++;
        deps.metrics.count('rescan_enqueue_failed');
        deps.log.error({ notificationId, err }, 'rescan: enqueue fanout_filter failed');
      }
    }
    if (ids.length < page) {
      break;
    }
    afterId = ids[ids.length - 1]!;
  }
  deps.metrics.count('rescan_enqueued', enqueued);
  deps.log.info({ enqueued, failed }, 'rescan finished');
}

/** Leader only; RESCAN_CRON plus 00:05 UTC on the 1st. */
export const rescanTimer = (deps: Deps): Timer => ({
  name: 'rescan',
  leaderOnly: true,
  schedule: anyOf(cronSchedule(deps.config.rescanCron), MONTH_START),
  run: rescan,
});
