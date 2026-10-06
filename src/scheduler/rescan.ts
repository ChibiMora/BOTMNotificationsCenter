// `rescan` timer (§8.3). Stub: the run is implemented by a later unit.
import type { Deps } from '../lib/deps.js';
import type { Timer } from './index.js';
import { anyOf, cronSchedule, MONTH_START } from './schedule.js';

/** Leader only; RESCAN_CRON plus 00:05 UTC on the 1st. */
export const rescanTimer = (deps: Deps): Timer => ({
  name: 'rescan',
  leaderOnly: true,
  schedule: anyOf(cronSchedule(deps.config.rescanCron), MONTH_START),
  run: async () => {},
});
