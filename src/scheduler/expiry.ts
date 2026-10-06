// `expiry` timer (§8.3). Stub: the run is implemented by a later unit.
import type { Deps } from '../lib/deps.js';
import type { Timer } from './index.js';
import { cronSchedule } from './schedule.js';

/** Leader only; EXPIRY_CRON. */
export const expiryTimer = (deps: Deps): Timer => ({
  name: 'expiry',
  leaderOnly: true,
  schedule: cronSchedule(deps.config.expiryCron),
  run: async () => {},
});
