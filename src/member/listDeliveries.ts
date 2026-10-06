/** GET /notifications: the caller's visible deliveries, newest first (B3), keyset-paginated by (sent_at, public_id). */
import type { Deps } from '../lib/deps.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { formatTimestamp } from '../lib/time.js';
import { validationError } from '../lib/errors.js';
import { listCursor, type ListQuery } from './schemas.js';
import { visibleDeliveries, type VisibleDeliveryRow } from './visibility.js';

function parseCursor(raw: string): { sentAt: Date; publicId: string } {
  const parsed = listCursor.safeParse(decodeCursor(raw));
  if (!parsed.success) throw validationError('malformed cursor');
  return { sentAt: new Date(parsed.data.s), publicId: parsed.data.p };
}

export async function listDeliveries(deps: Deps, accountId: number, query: ListQuery) {
  const q = visibleDeliveries(deps, accountId);
  if (query.cursor !== undefined) {
    const c = parseCursor(query.cursor);
    q.whereRaw('(d.sent_at, d.public_id) < (?, ?)', [c.sentAt, c.publicId]);
  }
  const rows: VisibleDeliveryRow[] = await q
    .orderBy([
      { column: 'd.sent_at', order: 'desc' },
      { column: 'd.public_id', order: 'desc' },
    ])
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > query.limit && last
      ? encodeCursor({ s: formatTimestamp(last.sent_at), p: last.public_id })
      : null;
  return {
    items: page.map((r) => ({
      id: r.public_id,
      headline: r.headline,
      subheadline: r.subheadline,
      isClicked: Boolean(r.is_clicked),
      liveDate: formatTimestamp(r.sent_at),
    })),
    nextCursor,
  };
}
