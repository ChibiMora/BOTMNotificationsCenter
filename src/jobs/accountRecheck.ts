// `account_recheck` job handler (§8.2). Stub: implemented by a later unit; throws so a job is never silently dropped.
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';

export const accountRecheck: (
  deps: Deps,
  payload: JobPayloads['account_recheck'],
  ctx: JobContext,
) => Promise<void> = async () => {
  throw new Error('account_recheck handler not implemented');
};
