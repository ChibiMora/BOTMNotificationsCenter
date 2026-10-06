/** Admin router (§4): mounted under /admin, case-sensitive (the gate is case-insensitive); requireAdmin already gates every /admin path in createApp. Routes are added by later units. */
import Router from '@koa/router';
import type { Deps } from '../lib/deps.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub: later units use deps for their routes
export function adminRouter(_deps: Deps): Router {
  return new Router({ prefix: '/admin', sensitive: true });
}
