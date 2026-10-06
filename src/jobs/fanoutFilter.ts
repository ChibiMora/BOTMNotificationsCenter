// `fanout_filter` job handler (§8.2). Stub: implemented by a later unit; throws so a job is never silently dropped.
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';

export const fanoutFilter: (
  deps: Deps,
  payload: JobPayloads['fanout_filter'],
  ctx: JobContext,
) => Promise<void> = async () => {
  throw new Error('fanout_filter handler not implemented');
};
