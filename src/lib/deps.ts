import type { Knex } from 'knex';
import type { Config } from '../config/index.js';
import type { Clock } from './clock.js';
import type { AuthProvider } from '../middleware/auth.js';
import type { Queue } from '../queue/queue.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
export interface Deps {
  db: Knex;
  dbReader: Knex;
  config: Config;
  clock: Clock;
  auth: AuthProvider;
  queue: Queue;
  log: Logger;
  metrics: Metrics;
}
