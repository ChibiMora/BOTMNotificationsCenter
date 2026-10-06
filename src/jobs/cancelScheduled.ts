// `cancel_scheduled` job handler (§8.2). Stub: implemented by a later unit; throws so a job is never silently dropped.
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';

export const cancelScheduled: (
  deps: Deps,
  payload: JobPayloads['cancel_scheduled'],
  ctx: JobContext,
) => Promise<void> = async () => {
  throw new Error('cancel_scheduled handler not implemented');
};
