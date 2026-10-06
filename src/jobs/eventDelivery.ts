// `event_delivery` job handler (§8.2). Stub: implemented by a later unit; throws so a job is never silently dropped.
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';

export const eventDelivery: (
  deps: Deps,
  payload: JobPayloads['event_delivery'],
  ctx: JobContext,
) => Promise<void> = async () => {
  throw new Error('event_delivery handler not implemented');
};
