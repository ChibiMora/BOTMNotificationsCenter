/** createApp(deps): the pure Koa factory (§6.3) used by api.ts and by tests. Middleware order is §9.1. */
import Koa from 'koa';
import type Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import type { Deps } from './lib/deps.js';
import { AppError } from './lib/errors.js';
import { requestContext } from './middleware/requestContext.js';
import { errorMapper } from './middleware/errorMapper.js';
import { auth } from './middleware/auth.js';
import { rateLimit, isAdminPath } from './middleware/rateLimit.js';
import { requireAdmin } from './middleware/requireAdmin.js';
import { adminRouter } from './admin/router.js';
import { memberRouter } from './member/router.js';

const JSON_LIMIT = '1mb';

/** /healthz (process up) and /readyz (database ping); mounted before auth. */
function health(deps: Deps): Koa.Middleware {
  return async (ctx, next) => {
    // HEAD as well as GET: load balancers probe with HEAD (Koa sends the headers without the body).
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
      return next();
    }
    if (ctx.path === '/healthz') {
      ctx.body = { status: 'ok' };
      return;
    }
    if (ctx.path === '/readyz') {
      try {
        await deps.db.raw('select 1');
      } catch (err) {
        ctx.state.log?.warn({ err }, 'readiness ping failed');
        deps.metrics.count('readiness_failed', 1, { process: 'api' });
        throw new AppError('UNAVAILABLE', 503, 'database unavailable');
      }
      ctx.body = { status: 'ok' };
      return;
    }
    return next();
  };
}

/** Gates every /admin path, whether or not a route matches, so non-admins get 403 rather than 404. */
function adminGate(deps: Deps): Koa.Middleware {
  const gate = requireAdmin(deps);
  return (ctx, next) => (isAdminPath(ctx.path) ? gate(ctx, next) : next());
}

/** The routers createApp mounts; tests pass the real routers with probe routes added.
 *  Admin routes must live under the `/admin` prefix: the gate keys on the path, not on which router serves the route. */
export type Routers = { admin: Router; member: Router };

export function createApp(
  deps: Deps,
  routers: Routers = { admin: adminRouter(deps), member: memberRouter(deps) },
): Koa {
  const app = new Koa();
  app.use(requestContext(deps));
  app.use(errorMapper());
  app.use(health(deps));
  app.use(auth(deps));
  app.use(rateLimit(deps));
  app.use(adminGate(deps));
  app.use(bodyParser({ enableTypes: ['json'], jsonLimit: JSON_LIMIT }));
  app.use(routers.admin.routes());
  app.use(routers.member.routes());
  // No allowedMethods(): the §3.2 error contract has no 405, so a wrong method on an existing path
  // (like an unknown path) falls through to the standard 404 NOT_FOUND envelope below.
  app.use(() => {
    throw new AppError('NOT_FOUND', 404);
  });
  return app;
}
