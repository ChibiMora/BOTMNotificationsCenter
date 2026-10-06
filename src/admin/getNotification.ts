/** GET /admin/notifications/:id (§3.4). */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import { idParamSchema } from './schemas.js';
import { loadNotification, presentDetail } from './presenter.js';

export async function getNotification(deps: Deps, ctx: Koa.Context & { params: Record<string, string> }) {
  const id = idParamSchema.parse(ctx.params.id);
  ctx.body = presentDetail(deps.config, await loadNotification(deps.db, id));
}
