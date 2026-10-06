/** Enqueue after commit (§7.2–§7.4): a failed enqueue never fails the request; it is logged (ids only) and recovered by housekeeping. */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import type { Logger } from '../lib/logger.js';
import type { JobPayloads, JobType } from '../queue/queue.js';

/** Enqueues `job`; on failure logs `<job> enqueue failed` with `ids` through the request-scoped logger. */
export async function enqueueAfterCommit<T extends JobType>(
  deps: Deps,
  ctx: Koa.Context,
  job: T,
  payload: JobPayloads[T],
  ids: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.queue.enqueue(job, payload);
  } catch (err) {
    const log = (ctx.state.log as Logger | undefined) ?? deps.log;
    log.error({ ...ids, err }, `${job} enqueue failed`);
  }
}
