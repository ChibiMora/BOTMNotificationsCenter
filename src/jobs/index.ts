// Job handler registry (§6.3): the single list of job types and their handlers, plus the dead-letter hook.
import type { Deps } from '../lib/deps.js';
import type { ConsumeOptions, JobHandlers, JobPayloads } from '../queue/queue.js';
import { fanoutFilter } from './fanoutFilter.js';
import { processImport, onProcessImportDead } from './processImport.js';
import { eventDelivery } from './eventDelivery.js';
import { accountRecheck } from './accountRecheck.js';
import { cancelScheduled } from './cancelScheduled.js';

export function jobHandlers(deps: Deps): JobHandlers {
  return {
    fanout_filter: (payload, ctx) => fanoutFilter(deps, payload, ctx),
    process_import: (payload, ctx) => processImport(deps, payload, ctx),
    event_delivery: (payload, ctx) => eventDelivery(deps, payload, ctx),
    account_recheck: (payload, ctx) => accountRecheck(deps, payload, ctx),
    cancel_scheduled: (payload, ctx) => cancelScheduled(deps, payload, ctx),
  };
}

/** Payload fields that are ids, the only part of a payload ever logged (§9.5: notification content is never logged). */
const LOGGED_ID_FIELDS = [
  'notificationId',
  'accountId',
  'importId',
  'runId',
  'requestId',
  'occurrenceKey',
] as const;

/** The id fields present in a job payload, picked explicitly so the raw payload never reaches a log line. */
function payloadIds(payload: object): Record<string, unknown> {
  const ids: Record<string, unknown> = {};
  for (const k of LOGGED_ID_FIELDS) {
    const v = (payload as Record<string, unknown>)[k];
    if (v !== undefined) {
      ids[k] = v;
    }
  }
  return ids;
}

/** Called once per job after its final failed attempt: logs, counts job_dead, then the type's own hook. */
export function onDead(deps: Deps): ConsumeOptions['onDead'] {
  return async (type, payload, error) => {
    deps.log.error({ type, ...payloadIds(payload), err: error }, 'job dead');
    deps.metrics.count('job_dead', 1, { type });
    if (type === 'process_import') {
      await onProcessImportDead(deps, payload as JobPayloads['process_import'], error);
    }
  };
}
