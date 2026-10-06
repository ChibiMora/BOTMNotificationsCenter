// NotificationTrigger (§6.4, §8.2, B11): imported by the ship / enroll / pre-enroll code paths.
// Each call enqueues exactly one job and never throws or rejects; failures are logged, counted and swallowed.
import type { Config } from '../config/index.js';
import { createWriterDb } from '../db/index.js';
import { systemClock } from '../lib/clock.js';
import type { Deps } from '../lib/deps.js';
import { createLogger } from '../lib/logger.js';
import { emfMetrics } from '../lib/metrics.js';
import { createQueue } from '../queue/index.js';
import type { EventTrigger } from '../queue/queue.js';

export type { EventTrigger } from '../queue/queue.js';

export interface TriggerEvent {
  type: EventTrigger;
  accountId: number;
  /** UTC instant of the occurrence. */
  occurredAt: Date;
  /** 1–128 chars; unique per real-world occurrence, e.g. `shipment:${id}`. */
  occurrenceKey: string;
}

const EVENT_TRIGGERS: readonly string[] = [
  'shipped',
  'enrolled',
  'preenrollAudiobook',
] satisfies EventTrigger[];
const FAILED = 'trigger_enqueue_failed';

const validAccountId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;

function validationError(e: TriggerEvent): string | undefined {
  if (typeof e !== 'object' || e === null) return 'event is not an object';
  if (typeof e.type !== 'string' || !EVENT_TRIGGERS.includes(e.type)) return 'unknown event type';
  if (!validAccountId(e.accountId)) return 'invalid account id';
  if (!(e.occurredAt instanceof Date) || Number.isNaN(e.occurredAt.getTime())) return 'invalid occurredAt';
  if (typeof e.occurrenceKey !== 'string' || e.occurrenceKey.length < 1 || e.occurrenceKey.length > 128) {
    return 'invalid occurrence key';
  }
  return undefined;
}

export class NotificationTrigger {
  constructor(private readonly deps: Pick<Deps, 'queue' | 'log' | 'metrics'>) {}

  // Both entry points are arrow-function fields so `this` is lexical: they stay safe when called unbound,
  // passed as callbacks (`events.forEach(trigger.record)`, `p.then(trigger.accountChanged)`) or via `.call(x, …)`.

  /** Enqueues exactly one `event_delivery` job. Call it after the business write has committed. */
  readonly record = async (event: TriggerEvent): Promise<void> => {
    // Every property read happens inside safely(): a throwing getter or Proxy must not make record() reject.
    const context: Record<string, unknown> = { job: 'event_delivery' };
    await this.safely(context, async () => {
      const key: unknown = event?.occurrenceKey;
      if (typeof key === 'string') context.occurrenceKey = key.slice(0, 128);
      const invalid = validationError(event);
      if (invalid) throw new Error(invalid);
      await this.deps.queue.enqueue('event_delivery', {
        type: event.type,
        accountId: event.accountId,
        occurredAt: event.occurredAt.toISOString(),
        occurrenceKey: event.occurrenceKey,
      });
    });
  };

  /** Enqueues one `account_recheck` job. Call it after committing any change to an account's filter fields. */
  readonly accountChanged = async (accountId: number): Promise<void> => {
    const context: Record<string, unknown> = { job: 'account_recheck' };
    await this.safely(context, async () => {
      if (!validAccountId(accountId)) throw new Error('invalid account id');
      context.accountId = accountId;
      await this.deps.queue.enqueue('account_recheck', { accountId });
    });
  };

  /** Never throws: the body, the failure counting and the failure log are each wrapped. */
  private async safely(context: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
    let failure: unknown;
    try {
      await fn();
      return;
    } catch (err) {
      failure = err;
    }
    try {
      this.deps.metrics.count(FAILED, 1, { job: String(context.job) });
    } catch {
      // Never let metrics break the business call site.
    }
    try {
      let message: string | undefined;
      try {
        message = String((failure as Error)?.message);
      } catch {
        message = undefined;
      }
      this.deps.log.error({ ...context, err: message }, 'trigger enqueue failed');
    } catch {
      // Never let logging break the business call site.
    }
  }
}

const bundles = new Map<string, NotificationTrigger>();

/** Stable serialisation of the whole config (keys sorted at every level), so any differing setting gets its own bundle. */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

/**
 * Builds a ready trigger for business code that has only the shared Config. Enqueue-only: never consumes.
 * One bundle (and one database pool) per process per distinct configuration: the pool lives for the life of the
 * process, because the NotificationTrigger interface has no close(). A failed construction destroys the pool it
 * opened, rethrows, and is not cached.
 */
export function createNotificationTrigger(config: Config): NotificationTrigger {
  const key = stableKey(config);
  const existing = bundles.get(key);
  if (existing) return existing;
  const log = createLogger(config.logLevel, { service: 'trigger' });
  const metrics = emfMetrics(log, systemClock);
  const db = createWriterDb(config);
  let trigger: NotificationTrigger;
  try {
    const queue = createQueue(config, { db, clock: systemClock, log, metrics });
    trigger = new NotificationTrigger({ queue, log, metrics });
  } catch (err) {
    void db.destroy().catch(() => undefined);
    throw err;
  }
  bundles.set(key, trigger);
  return trigger;
}
