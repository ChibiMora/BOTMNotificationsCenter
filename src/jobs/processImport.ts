// `process_import` job handler (§8.2). Stub: implemented by a later unit; throws so a job is never silently dropped.
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';

/**
 * Contract for the real handler (later unit): it MUST touch `imports.updated_at` after every chunk it processes.
 * Housekeeping re-enqueues `process_import` for any import still `processing` whose `updated_at` is more than
 * 10 minutes old, so a long import that does not touch the row would be re-enqueued while still running.
 */
export const processImport: (
  deps: Deps,
  payload: JobPayloads['process_import'],
  ctx: JobContext,
) => Promise<void> = async () => {
  throw new Error('process_import handler not implemented');
};

/** Dead-letter hook for process_import (marks the import failed in the import unit). No-op for now. */
export const onProcessImportDead: (
  deps: Deps,
  payload: JobPayloads['process_import'],
  error: Error,
) => Promise<void> = async () => {};
