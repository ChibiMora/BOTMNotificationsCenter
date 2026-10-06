/** GET /notifications/:id: one visible delivery's full content. No side effects. Not visible → the standard 404 (B14). */
import type { Deps } from '../lib/deps.js';
import { notFound } from '../lib/errors.js';
import { findVisibleDelivery, toDetail } from './visibility.js';

export async function getDelivery(deps: Deps, accountId: number, publicId: string) {
  const row = await findVisibleDelivery(deps, accountId, publicId);
  if (!row) throw notFound('delivery');
  return toDetail(deps, row);
}
