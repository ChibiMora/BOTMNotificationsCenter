// `event_delivery` job handler (§7.1 event flow, §8.2; B9, B10): one delivery per active event notification for the
// occurrence, then the per-account filter check (§7.2).
import type { Deps } from '../lib/deps.js';
import { insertDeliveries, type NewDelivery } from '../lib/insertDeliveries.js';
import { truncateToSecond, windowStart } from '../lib/time.js';
import type { EventTrigger, JobContext, JobPayloads } from '../queue/queue.js';
import { recheckAccount } from './accountRecheck.js';

const DAY_MS = 86_400_000;
const EVENT_TRIGGERS: ReadonlySet<string> = new Set<EventTrigger>([
  'shipped',
  'enrolled',
  'preenrollAudiobook',
]);
const MAX_OCCURRENCE_KEY = 128;

/** The first invalid field of a payload, or null. The handler checks for itself rather than relying on the trigger. */
function invalidField(p: JobPayloads['event_delivery']): string | null {
  if (typeof p.type !== 'string' || !EVENT_TRIGGERS.has(p.type)) return 'type';
  if (!Number.isSafeInteger(p.accountId) || p.accountId <= 0) return 'accountId';
  if (typeof p.occurredAt !== 'string' || Number.isNaN(Date.parse(p.occurredAt))) return 'occurredAt';
  if (
    typeof p.occurrenceKey !== 'string' ||
    p.occurrenceKey.length === 0 ||
    p.occurrenceKey.length > MAX_OCCURRENCE_KEY
  )
    return 'occurrenceKey';
  return null;
}

export const eventDelivery: (
  deps: Deps,
  payload: JobPayloads['event_delivery'],
  ctx: JobContext,
) => Promise<void> = async (deps, payload) => {
  const invalid = invalidField(payload);
  if (invalid !== null) {
    // Ids only: never the payload's content (the key may be the bad field). No throw: a retry cannot fix it.
    const accountId = Number.isSafeInteger(payload.accountId) ? payload.accountId : undefined;
    deps.log.warn({ invalid, accountId }, 'event_delivery: invalid payload, dropped');
    deps.metrics.count('event_delivery_invalid_payload', 1);
    return;
  }
  const { type, accountId, occurredAt, occurrenceKey } = payload;
  // Truncated to whole seconds because the DATETIME columns (due_at, sent_at, created_at) store whole seconds.
  const occurred = truncateToSecond(new Date(occurredAt));
  const notifications: Array<{ id: number; delay: number | null }> = await deps
    .db('notifications')
    .select('id', 'delay')
    .where({ event_trigger: type, active: true, removed: false });

  const now = deps.clock.now();
  const earliest = windowStart(now);
  const rows: NewDelivery[] = [];
  let tooOld = 0;
  for (const n of notifications) {
    const delayDays = type === 'preenrollAudiobook' ? 0 : (n.delay ?? 0);
    const dueAt = new Date(occurred.getTime() + delayDays * DAY_MS);
    if (dueAt < earliest) {
      tooOld++;
      continue;
    }
    rows.push({
      notificationId: n.id,
      accountId,
      dedupeKey: occurrenceKey,
      occurrenceKey,
      dueAt,
      sentAt: null, // set below from the insert's own `now`
    });
  }
  if (tooOld > 0) {
    deps.metrics.count('event_delivery_too_old', tooOld, { type });
    deps.log.warn(
      { accountId, occurrenceKey, dropped: tooOld },
      'event_delivery: due_at before window start, dropped',
    );
  }

  if (rows.length > 0) {
    // ONE fresh now per insert, used for both sent_at (immediate rows) and created_at, so sent_at >= created_at.
    const insertNow = deps.clock.now();
    for (const r of rows) r.sentAt = r.dueAt <= insertNow ? insertNow : null;
    const result = await insertDeliveries(deps.db, rows, { now: insertNow });
    if (result.unknownAccounts.length > 0) {
      deps.log.warn({ accountId, occurrenceKey }, 'event_delivery: unknown account, event dropped');
      deps.metrics.count('event_delivery_unknown_account', 1, { type });
      return;
    }
    deps.metrics.count('event_deliveries_inserted', result.inserted, { type });
    deps.log.info(
      { accountId, occurrenceKey, inserted: result.inserted, alreadyDelivered: result.alreadyDelivered },
      'event_delivery done',
    );
  }
  await recheckAccount(deps, accountId);
};
