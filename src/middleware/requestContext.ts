/** Request context (§9.1, §9.5): request id, child logger, start time, X-Request-Id, one log line per request. */
import { randomUUID } from 'node:crypto';
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';

const PROBES = new Set(['/healthz', '/readyz']);
export function requestContext(
  deps: Pick<Deps, 'log' | 'clock'> & Partial<Pick<Deps, 'metrics'>>,
): Koa.Middleware {
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
      const matched = (ctx as { _matchedRoute?: string })._matchedRoute;
      const durationMs = deps.clock.now().getTime() - start;
      // Never bodies, headers or tokens.
      ctx.state.log.info(
        {
          requestId,
          method: ctx.method,
          route: matched ?? null,
          status: ctx.status,
          durationMs,
          accountId: ctx.state.accountId ?? null,
        },
        'request',
      );
      // §11.4: the route TEMPLATE (never the concrete URL, which carries ids) keeps cardinality low.
      // Probes (/healthz, /readyz, mounted outside the router) get their own fixed labels, not `unmatched`.
      const route = matched ?? (PROBES.has(ctx.path) ? ctx.path : 'unmatched');
      const status = String(ctx.status);
      deps.metrics?.count('http_requests', 1, { method: ctx.method, route, status });
      deps.metrics?.timing('http_request_duration_ms', durationMs, { method: ctx.method, route, status });
      if (ctx.status === 404 && /^\/notifications(\/|$)/.test(ctx.path))
        deps.metrics?.count('member_not_found', 1);
      if (ctx.status >= 500) deps.metrics?.count('http_5xx', 1, { route, status });
    }
  };
}
