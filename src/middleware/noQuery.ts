/** Shared query-string guard for every non-list route (§3.2): any key is unknown, rejected exactly as the list schemas reject one. */
import type { Middleware } from 'koa';
import { z } from 'zod';

/** A query string with no permitted keys; `.strict()` raises zod's unrecognized-keys issue → 400 VALIDATION_ERROR. */
const emptyQuery = z.object({}).strict();

/** Route middleware: rejects any query-string key before headers or body are looked at. */
export function noQuery(): Middleware {
  return async (ctx, next) => {
    emptyQuery.parse(ctx.query);
    await next();
  };
}
