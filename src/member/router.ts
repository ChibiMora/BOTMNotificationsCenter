/** Member router (/notifications), case-sensitive like the admin router. Routes are added by later units. */
import Router from '@koa/router';
import type { Deps } from '../lib/deps.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub: later units use deps for their routes
export function memberRouter(_deps: Deps): Router {
  return new Router({ sensitive: true });
}
