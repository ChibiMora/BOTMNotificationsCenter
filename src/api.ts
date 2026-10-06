/** API composition root (§6.3): the only place that builds real things for the HTTP process. */
import type { Server } from 'node:http';
import { loadConfig, type Config } from './config/index.js';
import { createWriterDb, createReaderDb } from './db/index.js';
import { createLogger } from './lib/logger.js';
import { isMainModule } from './lib/mainModule.js';
import { emfMetrics } from './lib/metrics.js';
import { safeMetrics } from './lib/safeMetrics.js';
import { systemClock } from './lib/clock.js';
import type { Deps } from './lib/deps.js';
import type { AuthProvider } from './middleware/auth.js';
import type { Queue } from './queue/queue.js';
import { createQueue, type DbQueueParts } from './queue/index.js';
import { HeaderAuthProvider } from './middleware/headerAuth.js';
import { createApp } from './app.js';

/** AUTH_IMPL → provider. Only the header stand-in exists; it is refused in production. */
export function selectAuth(config: Config): AuthProvider {
  if (config.authImpl === 'header') {
    if (config.production) {
      throw new Error('AUTH_IMPL=header (stand-in) is refused in production');
    }
    return new HeaderAuthProvider(config.adminAccountIds);
  }
  throw new Error(`AUTH_IMPL=${config.authImpl} is not a known auth provider (only "header" exists)`);
}

/**
 * QUEUE_IMPL → queue, built with the same parts as the worker. The API only enqueues: it never calls consume(),
 * so no poll loop or upkeep runs in this process. Unknown impls and the stand-in in production throw.
 */
export function selectQueue(config: Config, parts: DbQueueParts): Queue {
  return createQueue(config, parts);
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<Server> {
  const config = loadConfig(env);
  const log = createLogger(config.logLevel, { service: 'api' });
  const auth = selectAuth(config);
  const db = createWriterDb(config);
  const dbReader = createReaderDb(config);
  const clock = systemClock;
  // Every consumer (handlers, housekeeping, queue) gets the safe sink (§9); DbQueue's own wrap is then a no-op.
  const metrics = safeMetrics(emfMetrics(log, clock), log);
  const queue = selectQueue(config, { db, clock, log, metrics });
  const deps: Deps = { db, dbReader, config, clock, auth, queue, log, metrics };
  const server = createApp(deps).listen(config.port, () => log.info({ port: config.port }, 'api listening'));
  const shutdown = (signal: string) => {
    log.info({ signal }, 'api shutting down');
    server.close(() => {
      void Promise.all([db.destroy(), dbReader.destroy()]).finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

export { isMainModule };

const invokedDirectly = isMainModule(process.argv[1], import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
