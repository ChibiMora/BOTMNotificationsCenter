/** Presenters for admin responses: `NotificationDetail` (§3.3) and the admin list item (§3.4). */
import type { Knex } from 'knex';
import type { Config } from '../config/index.js';
import type { NotificationRow, NotificationTypeName } from '../lib/rows.js';
import { formatTimestamp } from '../lib/time.js';
import { toUrl } from '../lib/urls.js';
import { notFound } from '../lib/errors.js';

/** A notification row joined with its type name. */
export type NamedNotificationRow = NotificationRow & { type_name: NotificationTypeName };

const optTimestamp = (d: Date | null) => (d ? formatTimestamp(d) : null);

/** csv notifications are active until removed; filter/event follow the `active` flag. */
const isActive = (r: NamedNotificationRow) => (r.type_name === 'csv' ? !r.removed : Boolean(r.active));

/** Type-specific fields: present only for the types that have them. */
function typeFields(r: NamedNotificationRow): Record<string, unknown> {
  if (r.type_name === 'csv') return { liveDate: optTimestamp(r.live_date) };
  return { activatedAt: optTimestamp(r.went_live_at) };
}

export function presentListItem(r: NamedNotificationRow) {
  return {
    id: r.id,
    headline: r.headline,
    subheadline: r.subheadline,
    type: r.type_name,
    createdAt: formatTimestamp(r.created_at),
    ...typeFields(r),
    isActive: isActive(r),
    isRemoved: Boolean(r.removed),
  };
}

export function presentDetail(config: Config, r: NamedNotificationRow) {
  const detail: Record<string, unknown> = {
    id: r.id,
    type: r.type_name,
    image: toUrl(config.assetBaseUrl, r.image_key),
    headline: r.headline,
    subheadline: r.subheadline,
    link: toUrl(config.siteBaseUrl, r.link_path),
    isActive: isActive(r),
    isRemoved: Boolean(r.removed),
    createdAt: formatTimestamp(r.created_at),
    ...typeFields(r),
  };
  if (r.type_name === 'filter') detail.filters = r.filters ?? {};
  if (r.type_name === 'event') {
    detail.eventTrigger = r.event_trigger;
    detail.delay = r.delay;
  }
  return detail;
}

/** Base query: notifications joined with their type name. */
export const namedNotifications = (db: Knex) =>
  db('notifications as n')
    .join('notification_types as t', 't.id', 'n.type')
    .select('n.*', 't.name as type_name');

/** Loads one notification with its type name, or throws 404. */
export async function loadNotification(db: Knex, id: number): Promise<NamedNotificationRow> {
  const row = (await namedNotifications(db).where('n.id', id).first()) as NamedNotificationRow | undefined;
  if (!row) throw notFound('notification');
  return row;
}
