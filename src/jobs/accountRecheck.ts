/**
 * `account_recheck` job handler (§7.2 "When an account changes", §8.2): evaluates one account against every active
 * filter notification and sends each one it matches and has not received this month. `recheckAccount` is also called
 * at the end of `event_delivery`.
 */
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';
import type { NotificationRow } from '../lib/rows.js';
import { eligibleAccounts, forAccount, UnusableFiltersError } from '../eligibility/buildQuery.js';
import { activeFilterNotifications } from '../lib/filterNotifications.js';
import { insertDeliveries } from '../lib/insertDeliveries.js';
import { monthKey } from '../lib/time.js';

const PAGE = 500;

/** Inserts this month's live delivery of every matching active filter notification for one account; returns the count. */
export async function recheckAccount(
  deps: Deps,
  accountId: number,
  ctx?: JobContext,
  requestId?: string,
): Promise<number> {
  // One instant and one month key for the whole call, so a call spanning a month boundary cannot split across keys.
  const t = deps.clock.now();
  const dedupeKey = monthKey(t);
  let written = 0;
  let afterId = 0;
  for (;;) {
    const page: Array<Pick<NotificationRow, 'id' | 'filters'>> = await activeFilterNotifications(deps.db)
      .andWhere('n.id', '>', afterId)
      .orderBy('n.id')
      .limit(PAGE)
      .select('n.id', 'n.filters');
    for (const n of page) {
      // The writer, not the replica: this runs right after the account change commits, and a lagging replica would
      // still show the old attributes (a newly eligible account missed, a no-longer-eligible one sent).
      let eligibility: ReturnType<typeof eligibleAccounts>;
      try {
        eligibility = eligibleAccounts(deps.db, n.filters);
      } catch (err) {
        if (!(err instanceof UnusableFiltersError)) {
          throw err;
        }
        // One bad notification must not fail the job for the others; ids only, never the filters' content.
        deps.metrics.count('account_recheck_unusable_filters');
        deps.log.warn(
          { err, notificationId: n.id, accountId, requestId },
          'account_recheck: unusable filters, skipped',
        );
        continue;
      }
      const match = await forAccount(eligibility, accountId).first();
      if (!match) {
        continue;
      }
      const row = { notificationId: n.id, accountId, dedupeKey, dueAt: t, sentAt: t };
      // `now` stays fresh per insert: it becomes created_at, which the cancellation rule reads.
      const result = await insertDeliveries(deps.db, [row], { now: deps.clock.now() });
      written += result.inserted;
    }
    // Like fan-out: renew the lease after each page; a lost lease throws and ends the run.
    await ctx?.heartbeat();
    if (page.length < PAGE) {
      return written;
    }
    afterId = page[page.length - 1]!.id;
  }
}

export const accountRecheck: (
  deps: Deps,
  payload: JobPayloads['account_recheck'],
  ctx: JobContext,
) => Promise<void> = async (deps, payload, ctx) => {
  const written = await recheckAccount(deps, payload.accountId, ctx, payload.requestId);
  deps.metrics.count('account_recheck_deliveries_written', written);
  deps.log.info(
    { accountId: payload.accountId, written, requestId: payload.requestId },
    'account_recheck finished',
  );
};
