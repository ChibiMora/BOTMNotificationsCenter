/** POST /admin/notifications/filter (§3.4, §7.2, §9.4). */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import type { Logger } from '../lib/logger.js';
import { createFilterSchema, type Filters } from './schemas.js';
import { insertIdempotent } from './idempotentInsert.js';
import { presentDetail } from './presenter.js';

/** The filters as stored, with each (already de-duplicated) array sorted so that element order does not matter. */
const sortedFilters = (f: Filters): Filters =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]));

export async function createFilter(deps: Deps, ctx: Koa.Context) {
  const body = createFilterSchema.parse(ctx.request.body);
  const filters = body.filters ?? {};
  const { row, created } = await insertIdempotent(
    deps,
    ctx,
    'filter',
    { ...body, filters: sortedFilters(filters) },
    {
      image_key: body.image,
      headline: body.headline,
      subheadline: body.subheadline,
      link_path: body.link,
      active: body.isActive,
      filters: JSON.stringify(filters),
    },
  );
  // §7.2: the fan-out is enqueued after the insert has committed; a failed enqueue does not fail the request.
  // Logged through the request-scoped logger so the entry carries the request id; ids only, never content.
  if (created && body.isActive) {
    try {
      await deps.queue.enqueue('fanout_filter', { notificationId: row.id, requestId: ctx.state.requestId });
    } catch (err) {
      const log = (ctx.state.log as Logger | undefined) ?? deps.log;
      log.error({ err, notificationId: row.id }, 'fanout_filter enqueue failed');
    }
  }
  ctx.status = 201;
  ctx.body = presentDetail(deps.config, row);
}
