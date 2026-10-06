/** Rate limiting (§9.8): fixed one-minute window per (surface, accountId), in memory per app instance; 429 + Retry-After. */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import { AppError } from '../lib/errors.js';

const WINDOW_MS = 60_000;

/**
 * Case-insensitive on purpose: a superset of what the (case-sensitive) admin router can match, so no casing
 * of /admin can reach an admin route ungated or be charged to the member bucket. A bare prefix match (not
 * `/admin/`): the admin router prefixes by string concatenation, so a route registered without a leading slash
 * serves `/admin-x` or `/admin.json`. No member path starts with `/admin` (member routes live under `/notifications`).
 */
export const isAdminPath = (path: string) => path.toLowerCase().startsWith('/admin');

/** Each call holds its own counters, so every createApp gets a fresh limiter (no module-level state). */
export function rateLimit(deps: Pick<Deps, 'clock' | 'config'>): Koa.Middleware {
  let currentWindow = -1;
  let counts = new Map<string, number>();
  return async (ctx, next) => {
    const now = deps.clock.now().getTime();
    const window = Math.floor(now / WINDOW_MS);
    if (window !== currentWindow) {
      currentWindow = window;
      counts = new Map();
    }
    const admin = isAdminPath(ctx.path);
    const limit = admin ? deps.config.rateLimitAdminPerMin : deps.config.rateLimitMemberPerMin;
    const key = `${admin ? 'admin' : 'member'}:${ctx.state.accountId}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil(((window + 1) * WINDOW_MS - now) / 1000));
      ctx.set('Retry-After', String(retryAfter));
      throw new AppError('RATE_LIMITED', 429);
    }
    await next();
  };
}
