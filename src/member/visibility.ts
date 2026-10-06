/** The one member visibility query (§7.5, rule B1/B2/B14): caller's deliveries, sent, in window, notification not removed. */
import type { Knex } from 'knex';
import type { Deps } from '../lib/deps.js';
import { windowStart, formatTimestamp } from '../lib/time.js';
import { toUrl } from '../lib/urls.js';
import { PUBLIC_ID_SHAPE } from './schemas.js';

/** One visible delivery with its notification content, as selected by `visibleDeliveries`. */
export interface VisibleDeliveryRow {
  id: number;
  public_id: string;
  is_clicked: number | boolean;
  sent_at: Date;
  headline: string;
  subheadline: string;
  image_key: string;
  link_path: string;
}

/** Base query (rule B1); rows are VisibleDeliveryRow. Callers append either the list cursor/order/limit or `public_id = :id`. */
export function visibleDeliveries(deps: Deps, accountId: number): Knex.QueryBuilder {
  return deps
    .db('notification_deliveries as d')
    .join('notifications as n', 'n.id', 'd.notification_id')
    .select(
      'd.id',
      'd.public_id',
      'd.is_clicked',
      'd.sent_at',
      'n.headline',
      'n.subheadline',
      'n.image_key',
      'n.link_path',
    )
    .where('d.account_id', accountId)
    .whereNotNull('d.sent_at')
    .where('d.sent_at', '>=', windowStart(deps.clock.now()))
    .where('n.removed', false);
}

/**
 * Detail/clicked variant: the caller's visible delivery with this public_id, or undefined (→ 404).
 * An id that cannot be a public_id is not a visible delivery and is answered without querying (B14).
 */
export async function findVisibleDelivery(
  deps: Deps,
  accountId: number,
  publicId: string,
): Promise<VisibleDeliveryRow | undefined> {
  if (!PUBLIC_ID_SHAPE.test(publicId)) return undefined;
  const rows: VisibleDeliveryRow[] = await visibleDeliveries(deps, accountId)
    .where('d.public_id', publicId)
    .limit(1);
  return rows[0];
}

/** The GET /notifications/:id response shape (also returned by PATCH). */
export function toDetail(deps: Deps, row: VisibleDeliveryRow) {
  return {
    id: row.public_id,
    image: toUrl(deps.config.assetBaseUrl, row.image_key),
    headline: row.headline,
    subheadline: row.subheadline,
    link: toUrl(deps.config.siteBaseUrl, row.link_path),
    liveDate: formatTimestamp(row.sent_at),
    isClicked: Boolean(row.is_clicked),
  };
}
