/** Member router (/notifications), case-sensitive like the admin router. Parses input with the zod schemas, then delegates. */
import Router from '@koa/router';
import type { Deps } from '../lib/deps.js';
import { idParams, listQuery, patchBody } from './schemas.js';
import { listDeliveries } from './listDeliveries.js';
import { getDelivery } from './getDelivery.js';
import { updateDelivery } from './updateDelivery.js';

export function memberRouter(deps: Deps): Router {
  const router = new Router({ sensitive: true });

  router.get('/notifications', async (ctx) => {
    const query = listQuery.parse(ctx.query);
    ctx.body = await listDeliveries(deps, ctx.state.accountId, query);
  });

  router.get('/notifications/:id', async (ctx) => {
    const { id } = idParams.parse(ctx.params);
    ctx.body = await getDelivery(deps, ctx.state.accountId, id);
  });

  router.patch('/notifications/:id', async (ctx) => {
    const { id } = idParams.parse(ctx.params);
    patchBody.parse(ctx.request.body);
    ctx.body = await updateDelivery(deps, ctx.state.accountId, id);
  });

  return router;
}
