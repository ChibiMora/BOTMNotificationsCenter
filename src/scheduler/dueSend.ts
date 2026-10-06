// `due_send` timer (§8.3). Stub: the run is implemented by a later unit.
import type { Deps } from '../lib/deps.js';
import type { Timer } from './index.js';
import { intervalSchedule } from './schedule.js';

/** Runs on EVERY worker, every DUE_SEND_INTERVAL_SECONDS. */
export const dueSendTimer = (deps: Deps): Timer => ({
  name: 'due_send',
  leaderOnly: false,
  schedule: intervalSchedule(deps.config.dueSendIntervalSeconds),
  run: async () => {},
});
