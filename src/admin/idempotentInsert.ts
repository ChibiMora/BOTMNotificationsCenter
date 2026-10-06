/** The idempotent insert shared by the filter and event creates (§3.4, §9.4). */
import { createHash } from 'node:crypto';
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import type { NotificationTypeName } from '../lib/rows.js';
import { validationError } from '../lib/errors.js';
import { truncateToSecond } from '../lib/time.js';
import { loadNotification, type NamedNotificationRow } from './presenter.js';

/** Stable JSON: object keys sorted at every level, so reordered keys hash the same. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const isDuplicateRequestKey = (err: unknown) => {
  const e = err as { code?: string; message?: string; sqlMessage?: string };
  return (
    e?.code === 'ER_DUP_ENTRY' &&
    `${e.message ?? ''} ${e.sqlMessage ?? ''}`.includes('uq_notifications_request_key')
  );
};

/**
 * Inserts a notification under the request's Idempotency-Key. A replay of the same request returns the existing
 * row (`created: false`); the same key with a different request is a 400.
 *
 * `normalised` is the request as it will be stored (defaults applied, empty arrays dropped, arrays de-duplicated
 * and sorted, text trimmed); it is what is hashed, so requests that store the same row are the same request.
 *
 * Must run on the pool (`deps.db`), NOT inside a caller's transaction: the duplicate-key lookup has to see the
 * other request's committed row, and callers enqueue any job only after this returns. A duplicate is detected by
 * MySQL error code (`ER_DUP_ENTRY`) plus the unique index name (`uq_notifications_request_key`), so a duplicate on
 * any other unique index is rethrown.
 */
export async function insertIdempotent(
  deps: Deps,
  ctx: Koa.Context,
  type: NotificationTypeName,
  normalised: unknown,
  columns: Record<string, unknown>,
): Promise<{ row: NamedNotificationRow; created: boolean }> {
  const key = ctx.state.idempotencyKey as string;
  const hash = createHash('sha256').update(canonicalJson(normalised)).digest('hex');
  const now = truncateToSecond(deps.clock.now());
  const typeRow = await deps.db('notification_types').where({ name: type }).first('id');
  try {
    const [id] = await deps.db('notifications').insert({
      ...columns,
      type: typeRow.id,
      created_at: now,
      went_live_at: columns.active ? now : null,
      request_key: key,
      request_endpoint: type,
      request_hash: hash,
    });
    return { row: await loadNotification(deps.db, id!), created: true };
  } catch (err) {
    if (!isDuplicateRequestKey(err)) throw err;
  }
  const existing = await deps
    .db('notifications')
    .where({ request_key: key })
    .first('id', 'request_endpoint', 'request_hash');
  if (!existing || existing.request_endpoint !== type || existing.request_hash !== hash) {
    throw validationError('Idempotency-Key already used for a different request');
  }
  return { row: await loadNotification(deps.db, existing.id), created: false };
}
