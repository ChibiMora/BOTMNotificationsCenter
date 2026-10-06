/** Admin routes under `/admin` (§3.4). Auth and the admin gate run upstream; later units add update and import routes here. */
import Router from '@koa/router';
import type { Deps } from '../lib/deps.js';
import { idempotencyKey } from '../middleware/idempotencyKey.js';
import { listNotifications } from './listNotifications.js';
import { getNotification } from './getNotification.js';
import { createFilter } from './createFilter.js';
import { createEvent } from './createEvent.js';

export function adminRouter(deps: Deps): Router {
  const router = new Router({ prefix: '/admin', sensitive: true });
  router.get('/notifications', (ctx) => listNotifications(deps, ctx));
  router.get('/notifications/:id', (ctx) => getNotification(deps, ctx));
  router.post('/notifications/filter', idempotencyKey(), (ctx) => createFilter(deps, ctx));
  router.post('/notifications/event', idempotencyKey(), (ctx) => createEvent(deps, ctx));
  return router;
}
