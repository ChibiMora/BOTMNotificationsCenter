/** Request context (§9.1, §9.5): request id, child logger, start time, X-Request-Id, one log line per request. */
import { randomUUID } from 'node:crypto';
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';

export function requestContext(deps: Pick<Deps, 'log' | 'clock'>): Koa.Middleware {
  return async (ctx, next) => {
    const requestId = randomUUID();
    const start = deps.clock.now().getTime();
    ctx.state.requestId = requestId;
    ctx.state.startTime = start;
    ctx.state.log = deps.log.child({ requestId });
    ctx.set('X-Request-Id', requestId);
    try {
      await next();
    } finally {
      // Never bodies, headers or tokens.
      ctx.state.log.info(
        {
          requestId,
          method: ctx.method,
          route: (ctx as { _matchedRoute?: string })._matchedRoute ?? null,
          status: ctx.status,
          durationMs: deps.clock.now().getTime() - start,
          accountId: ctx.state.accountId ?? null,
        },
        'request',
      );
    }
  };
}
