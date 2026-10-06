/** Shared query-string guard for every non-list route (§3.2): any key is unknown, rejected exactly as the list schemas reject one. */
import type { Middleware } from 'koa';
import { z } from 'zod';

/** A query string with no permitted keys; `.strict()` raises zod's unrecognized-keys issue → 400 VALIDATION_ERROR. */
const emptyQuery = z.object({}).strict();

/**
 * Route middleware: rejects any query-string key before the multipart upload and handler. Mounted after the admin gate
 * and, on routes that take one, after the Idempotency-Key check (§9.1: requireAdmin → [idempotencyKey] → validate).
 */
export function noQuery(): Middleware {
  return async (ctx, next) => {
    emptyQuery.parse(ctx.query);
    await next();
  };
}
