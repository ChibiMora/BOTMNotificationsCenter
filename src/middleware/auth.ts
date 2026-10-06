/** The seam to the session + role system (§6.3) and the auth middleware (§9.1): session → ctx.state.accountId. */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import { AppError } from '../lib/errors.js';

// Stand-in: middleware/headerAuth.ts implements it from request headers (§9.1); the real provider replaces it later.
export interface AuthProvider {
  getSession(ctx: Koa.Context): Promise<{ accountId: number } | null>; // null → 401
  isAdmin(accountId: number): Promise<boolean>; // false → 403; throws → 503
}

/** null session → 401 UNAUTHORIZED; provider throwing → 503 UNAVAILABLE. */
export function auth(deps: Pick<Deps, 'auth'>): Koa.Middleware {
  return async (ctx, next) => {
    let session: { accountId: number } | null;
    try {
      session = await deps.auth.getSession(ctx);
    } catch (err) {
      ctx.state.log?.warn({ err }, 'session provider failed');
      throw new AppError('UNAVAILABLE', 503, 'session system unavailable');
    }
    if (!session) {
      throw new AppError('UNAUTHORIZED', 401);
    }
    ctx.state.accountId = session.accountId;
    await next();
  };
}
