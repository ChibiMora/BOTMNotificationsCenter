/** Idempotency-Key header (§3.1): must be a UUID → ctx.state.idempotencyKey; else 400. Applied per route by the admin router. */
import type Koa from 'koa';
import { validationError } from '../lib/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idempotencyKey(): Koa.Middleware {
  return async (ctx, next) => {
    const key = ctx.get('idempotency-key');
    if (!UUID.test(key)) {
      throw validationError('Idempotency-Key header must be a UUID');
    }
    ctx.state.idempotencyKey = key.toLowerCase();
    await next();
  };
}
