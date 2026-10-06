// `event_delivery` job handler (§7.1 event flow, §8.2; B9, B10): one delivery per active event notification for the
// occurrence, then the per-account filter check (§7.2).
import type { Deps } from '../lib/deps.js';
import { insertDeliveries, type NewDelivery } from '../lib/insertDeliveries.js';
import { truncateToSecond, windowStart } from '../lib/time.js';
import { EVENT_TRIGGERS, MAX_OCCURRENCE_KEY, type JobContext, type JobPayloads } from '../queue/queue.js';
import { recheckAccount } from './accountRecheck.js';

const DAY_MS = 86_400_000;
const EVENT_TRIGGER_SET: ReadonlySet<string> = new Set<string>(EVENT_TRIGGERS);
// Strict ISO-8601 UTC: `YYYY-MM-DDTHH:MM:SS[.fff…]Z`. Anything else (local-time strings, bare numbers, offsets) is
// rejected rather than left to Date.parse's lenient, partly local-time reading.
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
// The DATETIME range the delivery columns can store (whole days); anything outside can never be inserted.
const MIN_MS = Date.UTC(1000, 0, 1);
const MAX_MS = Date.UTC(9999, 0, 1); // exclusive: anything on 9998-12-31 is accepted
const inRange = (ms: number) => ms >= MIN_MS && ms < MAX_MS;

/** True when `s` is a strict UTC timestamp naming a real calendar instant (no roll-over, e.g. Feb 30) in range. */
function validOccurredAt(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = ISO_UTC.exec(s);
  if (!m) return false;
  const ms = Date.parse(s);
  if (Number.isNaN(ms) || !inRange(ms)) return false;
  const d = new Date(ms);
  const [y, mo, day, h, mi, sec] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return (
    d.getUTCFullYear() === y &&
    d.getUTCMonth() + 1 === mo &&
    d.getUTCDate() === day &&
    d.getUTCHours() === h &&
    d.getUTCMinutes() === mi &&
    d.getUTCSeconds() === sec
  );
}

/** The first invalid field of a payload, or null. The handler checks for itself rather than relying on the trigger. */
function invalidField(p: JobPayloads['event_delivery']): string | null {
  if (typeof p !== 'object' || p === null) return 'payload';
  if (typeof p.type !== 'string' || !EVENT_TRIGGER_SET.has(p.type)) return 'type';
  if (!Number.isSafeInteger(p.accountId) || p.accountId <= 0) return 'accountId';
  if (!validOccurredAt(p.occurredAt)) return 'occurredAt';
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
) => Promise<void> = async (deps, payload, ctx) => {
  // Ids only: never the payload's content (the key may be the bad field). No throw: a retry cannot fix it.
  const rejectPayload = (invalid: string) => {
    const raw: unknown = typeof payload === 'object' && payload !== null ? payload.accountId : undefined;
    const accountId = Number.isSafeInteger(raw) ? raw : undefined;
    const rid: unknown = typeof payload === 'object' && payload !== null ? payload.requestId : undefined;
    const requestId = typeof rid === 'string' ? rid : undefined;
    const err = new Error(`event_delivery payload: invalid ${invalid}`);
    deps.log.warn({ err, invalid, accountId, requestId }, 'event_delivery: invalid payload, dropped');
    deps.metrics.count('event_delivery_invalid_payload', 1);
  };
  const invalid = invalidField(payload);
  if (invalid !== null) return rejectPayload(invalid);
  const { type, accountId, occurredAt, occurrenceKey, requestId } = payload;
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
    // A due_at past the DATETIME range would fail the insert on every retry (a poison job): the payload is invalid.
    if (!inRange(dueAt.getTime())) return rejectPayload('occurredAt');
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
      { accountId, occurrenceKey, dropped: tooOld, requestId },
      'event_delivery: due_at before window start, dropped',
    );
  }

  if (rows.length > 0) {
    // ONE fresh now per insert, used for both sent_at (immediate rows) and created_at, so sent_at >= created_at.
    const insertNow = deps.clock.now();
    for (const r of rows) r.sentAt = r.dueAt <= insertNow ? insertNow : null;
    const result = await insertDeliveries(deps.db, rows, { now: insertNow });
    if (result.unknownAccounts.length > 0) {
      deps.log.warn(
        { accountId, occurrenceKey, requestId },
        'event_delivery: unknown account, event dropped',
      );
      deps.metrics.count('event_delivery_unknown_account', 1, { type });
      return;
    }
    deps.metrics.count('event_delivery_inserted', result.inserted, { type });
    deps.log.info(
      {
        accountId,
        occurrenceKey,
        inserted: result.inserted,
        alreadyDelivered: result.alreadyDelivered,
        requestId,
      },
      'event_delivery done',
    );
  }
  await recheckAccount(deps, accountId, ctx, requestId);
};
