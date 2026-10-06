/** Enqueue after commit (§7.2–§7.4): a failed enqueue never fails the request; it is logged (ids only) and recovered by housekeeping. */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import type { Logger } from '../lib/logger.js';

type Enqueue = Deps['queue']['enqueue'];

/** Enqueues `job`; on failure logs `<job> enqueue failed` with `ids` through the request-scoped logger. */
export async function enqueueAfterCommit(
  deps: Deps,
  ctx: Koa.Context,
  job: Parameters<Enqueue>[0],
  payload: Parameters<Enqueue>[1],
  ids: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.queue.enqueue(job, payload);
  } catch (err) {
    const log = (ctx.state.log as Logger | undefined) ?? deps.log;
    log.error({ err, ...ids }, `${job} enqueue failed`);
  }
}
