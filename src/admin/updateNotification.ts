/** PATCH /admin/notifications/:id (§3.4, §7.4, B4–B6). */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import type { JobType } from '../queue/queue.js';
import { enqueueAfterCommit } from './enqueueAfterCommit.js';
import { AppError, notFound } from '../lib/errors.js';
import { withTransaction } from '../db/index.js';
import { idParamSchema, updateNotificationSchema } from './schemas.js';
import { loadNotification, presentDetail, type NamedNotificationRow } from './presenter.js';

type Outcome = { row: NamedNotificationRow; job: JobType | null };

export async function updateNotification(deps: Deps, ctx: Koa.Context & { params: Record<string, string> }) {
  // Shape first (400), before any database access.
  const id = idParamSchema.parse(ctx.params.id);
  const body = updateNotificationSchema.parse(ctx.request.body);
  const now = deps.clock.now();

  // Every decision is made on the locked row so two concurrent updates cannot both apply.
  const { row, job } = await withTransaction(deps.db, async (trx): Promise<Outcome> => {
    // Lock only the notification row (no join, so the type row is not locked). Busy → errno 3572 → 409.
    const locked = await trx('notifications').where({ id }).forUpdate().noWait().first('id');
    if (!locked) throw notFound('notification');
    const current = await loadNotification(trx, id);
    if (current.removed) throw new AppError('CONFLICT', 409, 'notification is removed');

    if ('isRemoved' in body) {
      await trx('notifications')
        .where({ id })
        .update({ removed: true, active: false, cancelled_before: now });
      return { row: await loadNotification(trx, id), job: 'cancel_scheduled' };
    }
    if (current.type_name === 'csv') {
      throw new AppError('VALIDATION_ERROR', 400, 'isActive is not allowed on csv notifications');
    }
    if (Boolean(current.active) === body.isActive) return { row: current, job: null };

    if (body.isActive) {
      // B4: first activation time is set once and never overwritten; cancelled_before is left as it is.
      await trx('notifications')
        .where({ id })
        .update({ active: true, went_live_at: trx.raw('COALESCE(went_live_at, ?)', [now]) });
      const row = await loadNotification(trx, id);
      return { row, job: row.type_name === 'filter' ? 'fanout_filter' : null };
    }
    // B5: cancelled_before comes from the application clock and is never cleared by a later reactivation.
    await trx('notifications').where({ id }).update({ active: false, cancelled_before: now });
    return { row: await loadNotification(trx, id), job: 'cancel_scheduled' };
  });

  // §7.4: enqueued after the commit; a failed enqueue does not fail the request. Ids only, never content.
  if (job) {
    await enqueueAfterCommit(
      deps,
      ctx,
      job,
      { notificationId: id, requestId: ctx.state.requestId },
      { notificationId: id },
    );
  }
  ctx.body = presentDetail(deps.config, row);
}
