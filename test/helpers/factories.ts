// Test fixtures only. Factories insert delivery rows DIRECTLY (bypassing lib/insertDeliveries) on purpose: tests need
// rows with arbitrary created_at/sent_at that the helper, which stamps created_at from `now`, cannot produce.
// Production code must never insert into notification_deliveries except through lib/insertDeliveries.
import type { Knex } from 'knex';
import type { NotificationRow, DeliveryRow, ImportRow, NotificationTypeName } from '../../src/lib/rows.js';
import { newPublicId } from '../../src/lib/publicId.js';
import { FixedClock } from './clock.js';
/** Timestamps come from explicit arguments or the fixed test clock, never the wall clock. */
const TYPE_ID: Record<NotificationTypeName, number> = { filter: 1, event: 2, csv: 3 };
const PER_TYPE: Record<NotificationTypeName, Record<string, unknown>> = {
  filter: { filters: JSON.stringify({}) },
  event: { event_trigger: 'shipped', delay: 0 },
  csv: { live_date: new Date('2026-10-01T04:00:00Z') },
};
export async function makeNotification(
  db: Knex,
  type: NotificationTypeName,
  o: Record<string, unknown> = {},
  now: Date = new FixedClock().now(),
): Promise<NotificationRow> {
  const [id] = await db('notifications').insert({
    created_at: now,
    type: TYPE_ID[type],
    image_key: '/img/a.png',
    headline: 'H',
    subheadline: 'S',
    link_path: '/x',
    ...PER_TYPE[type],
    ...o,
  });
  return db('notifications').where({ id }).first();
}
export async function makeDelivery(
  db: Knex,
  o: Partial<DeliveryRow> & { notification_id: number; account_id: number },
  now: Date = new FixedClock().now(),
): Promise<DeliveryRow> {
  const [id] = await db('notification_deliveries').insert({
    created_at: now,
    public_id: newPublicId(),
    due_at: new Date('2026-10-01T00:00:00Z'),
    dedupe_key: newPublicId(),
    ...o,
  });
  return db('notification_deliveries').where({ id }).first();
}
export async function makeImport(
  db: Knex,
  o: Partial<ImportRow> & { notification_id: number },
  now: Date = new FixedClock().now(),
): Promise<ImportRow> {
  const [id] = await db('imports').insert({
    created_at: now,
    updated_at: now,
    request_key: crypto.randomUUID(),
    request_hash: '0'.repeat(64),
    ...o,
  });
  return db('imports').where({ id }).first();
}
