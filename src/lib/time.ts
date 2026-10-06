import { validationError } from './errors.js';
export const truncateToSecond = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);
/** ISO-8601 UTC, second precision, Z suffix (§3.1). */
export const formatTimestamp = (d: Date) => truncateToSecond(d).toISOString().replace('.000Z', 'Z');
/** Start of the visibility window: midnight UTC on the 1st of the previous calendar month. */
export const windowStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
/** UTC month 'YYYY-MM' (filter dedupe_key). */
export const monthKey = (now: Date) => now.toISOString().slice(0, 7);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const validYmd = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
/** Offset (ms) of `tz` from UTC at instant `t`, via Intl. */
function tzOffsetMs(t: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t.getTime();
}
/** MySQL DATETIME range; instants are stored in UTC, so the range is checked in UTC for every accepted form. */
const MIN_STORABLE_MS = Date.UTC(1000, 0, 1, 0, 0, 0);
const MAX_STORABLE_MS = Date.UTC(9999, 11, 31, 23, 59, 59);

function storable(t: Date, s: string): Date {
  const ms = t.getTime();
  if (ms < MIN_STORABLE_MS || ms > MAX_STORABLE_MS) throw validationError(`timestamp out of range: ${s}`);
  return t;
}

/** Parse a request timestamp (§3.1): date-time with Z/offset, or a plain date = midnight in `tz`. Throws 400 otherwise. */
export function parseRequestTimestamp(s: string, tz: string): Date {
  let m = DATE_RE.exec(s);
  if (m) {
    const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
    if (!validYmd(y, mo, d)) throw validationError(`invalid date: ${s}`);
    // Local midnight as wall-clock ms. Try the offsets in force a day either side; a candidate is valid when its wall
    // clock reads exactly midnight. Overlap: take the earliest. Gap at midnight (no valid candidate): the day starts at
    // the transition instant, i.e. midnight under the pre-transition offset.
    const wall = Date.UTC(y, mo - 1, d);
    const before = wall - tzOffsetMs(new Date(wall - 86_400_000), tz);
    const after = wall - tzOffsetMs(new Date(wall + 86_400_000), tz);
    const valid = [before, after].filter((c) => c + tzOffsetMs(new Date(c), tz) === wall);
    return storable(new Date(valid.length > 0 ? Math.min(...valid) : before), s);
  }
  m = DATETIME_RE.exec(s);
  if (!m || !validYmd(+m[1]!, +m[2]!, +m[3]!) || +m[4]! > 23 || +m[5]! > 59 || +m[6]! > 59)
    throw validationError(`invalid timestamp: ${s}`);
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) throw validationError(`invalid timestamp: ${s}`);
  return storable(truncateToSecond(t), s);
}
