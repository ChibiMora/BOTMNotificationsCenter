/** Admin gate (§3.1, §9.1): isAdmin false → 403 FORBIDDEN; provider throwing → 503 UNAVAILABLE. Runs after auth. */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import { AppError } from '../lib/errors.js';

export function requireAdmin(deps: Pick<Deps, 'auth'>): Koa.Middleware {
  return async (ctx, next) => {
    let admin: boolean;
    try {
      admin = await deps.auth.isAdmin(ctx.state.accountId);
    } catch (err) {
      ctx.state.log?.warn({ err }, 'role provider failed');
      throw new AppError('UNAVAILABLE', 503, 'role system unavailable');
    }
    if (admin !== true) {
      throw new AppError('FORBIDDEN', 403);
    }
    await next();
  };
}
