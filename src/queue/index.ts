// Queue selection (§8.1): the only place that maps QUEUE_IMPL to an implementation.
import type { Config } from '../config/index.js';
import type { Queue } from './queue.js';
import { DbQueue, type DbQueueParts } from './dbQueue.js';

export type { DbQueueParts } from './dbQueue.js';

export function createQueue(config: Config, parts: DbQueueParts): Queue {
  if (config.queueImpl === 'db') {
    // Second line of defence behind loadConfig: the stand-in is never built for a production config.
    if (config.production) {
      throw new Error('QUEUE_IMPL=db (stand-in) is refused in production');
    }
    return new DbQueue(config, parts);
  }
  throw new Error(`no adapter for QUEUE_IMPL=${String(config.queueImpl)}`);
}
