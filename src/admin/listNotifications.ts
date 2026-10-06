/** GET /admin/notifications (§3.4): every record, newest first, keyset-paginated. */
import { createHash } from 'node:crypto';
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { validationError } from '../lib/errors.js';
import { formatTimestamp, parseRequestTimestamp } from '../lib/time.js';
import { listQuerySchema } from './schemas.js';
import { namedNotifications, presentListItem, type NamedNotificationRow } from './presenter.js';

const WHOLE_SECOND_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Fingerprint of the filters a cursor was issued under, so it cannot be reused under others. */
const fingerprint = (type: string | null, from: Date | null, to: Date | null) =>
  createHash('sha256')
    .update(JSON.stringify([type, from?.toISOString() ?? null, to?.toISOString() ?? null]))
    .digest('base64url')
    .slice(0, 16);

/** Decodes and strictly validates a cursor `{ c, i, f }`; anything else is a 400. */
function readCursor(s: string, f: string): { c: Date; i: number } {
  const v = decodeCursor(s);
  const { c, i } = v;
  const valid =
    Object.keys(v).length === 3 &&
    typeof c === 'string' &&
    WHOLE_SECOND_Z.test(c) &&
    !Number.isNaN(Date.parse(c)) &&
    formatTimestamp(new Date(c)) === c &&
    typeof i === 'number' &&
    Number.isSafeInteger(i) &&
    i >= 1 &&
    i <= 4294967295 &&
    typeof v.f === 'string';
  if (!valid) throw validationError('malformed cursor');
  if (v.f !== f) throw validationError('cursor was issued under different filters');
  return { c: new Date(c), i };
}

export async function listNotifications(deps: Deps, ctx: Koa.Context) {
  const q = listQuerySchema.parse(ctx.query);
  const limit = q.limit ?? 25;
  const tz = deps.config.businessTimezone;
  const from = q.createdFrom === undefined ? null : parseRequestTimestamp(q.createdFrom, tz);
  const to = q.createdTo === undefined ? null : parseRequestTimestamp(q.createdTo, tz);
  const f = fingerprint(q.type ?? null, from, to);
  const cursor = q.cursor === undefined ? null : readCursor(q.cursor, f);

  const query = namedNotifications(deps.db)
    .orderBy([
      { column: 'n.created_at', order: 'desc' },
      { column: 'n.id', order: 'desc' },
    ])
    .limit(limit + 1);
  if (q.type) query.where('t.name', q.type);
  if (from) query.where('n.created_at', '>=', from);
  if (to) query.where('n.created_at', '<', to);
  // The row-value predicate is the contract's form; the redundant `created_at <= c` gives MySQL a range start so
  // deep pages seek instead of scanning from the newest row.
  if (cursor) {
    query
      .where('n.created_at', '<=', cursor.c)
      .whereRaw('(n.created_at, n.id) < (?, ?)', [cursor.c, cursor.i]);
  }

  const rows = (await query) as NamedNotificationRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ c: formatTimestamp(last.created_at), i: last.id, f }) : null;
  ctx.body = { items: page.map(presentListItem), nextCursor };
}
