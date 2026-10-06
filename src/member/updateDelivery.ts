/** PATCH /notifications/:id: set is_clicked once (§7.5). Idempotent: a repeat changes 0 rows and still returns 200. */
import type { Deps } from '../lib/deps.js';
import { notFound } from '../lib/errors.js';
import { findVisibleDelivery, toDetail } from './visibility.js';

export async function updateDelivery(deps: Deps, accountId: number, publicId: string) {
  const row = await findVisibleDelivery(deps, accountId, publicId);
  if (!row) throw notFound('delivery');
  // Rows changed (not matched) is returned because FOUND_ROWS is off; it is deliberately ignored.
  await deps
    .db('notification_deliveries')
    .where({ id: row.id, account_id: accountId, is_clicked: false })
    .update({ is_clicked: true });
  return toDetail(deps, { ...row, is_clicked: true });
}
