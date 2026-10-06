/** Admin routes under `/admin` (§3.4). Auth and the admin gate run upstream. */
import Router from '@koa/router';
import type { Deps } from '../lib/deps.js';
import { idempotencyKey } from '../middleware/idempotencyKey.js';
import { noQuery } from '../middleware/noQuery.js';
import { listNotifications } from './listNotifications.js';
import { getNotification } from './getNotification.js';
import { createFilter } from './createFilter.js';
import { createEvent } from './createEvent.js';
import { updateNotification } from './updateNotification.js';
import { createImport, importUpload } from './createImport.js';
import { getImport } from './getImport.js';
import { createImportRun } from './createImportRun.js';

export function adminRouter(deps: Deps): Router {
  const router = new Router({ prefix: '/admin', sensitive: true });
  router.get('/notifications', (ctx) => listNotifications(deps, ctx));
  router.get('/notifications/imports/:id', noQuery(), (ctx) => getImport(deps, ctx));
  router.get('/notifications/:id', noQuery(), (ctx) => getNotification(deps, ctx));
  router.post('/notifications/filter', noQuery(), idempotencyKey(), (ctx) => createFilter(deps, ctx));
  router.post('/notifications/event', noQuery(), idempotencyKey(), (ctx) => createEvent(deps, ctx));
  router.post('/notifications/imports', noQuery(), idempotencyKey(), importUpload(deps), (ctx) =>
    createImport(deps, ctx),
  );
  router.post('/notifications/imports/:id/runs', noQuery(), idempotencyKey(), (ctx) =>
    createImportRun(deps, ctx),
  );
  router.patch('/notifications/:id', noQuery(), (ctx) => updateNotification(deps, ctx));
  return router;
}
