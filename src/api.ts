/** API composition root (§6.3): the only place that builds real things for the HTTP process. */
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { loadConfig, type Config } from './config/index.js';
import { createWriterDb, createReaderDb } from './db/index.js';
import { createLogger } from './lib/logger.js';
import { emfMetrics } from './lib/metrics.js';
import { systemClock } from './lib/clock.js';
import type { Deps } from './lib/deps.js';
import type { AuthProvider } from './middleware/auth.js';
import type { Queue } from './queue/queue.js';
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

/** QUEUE_IMPL → queue. Wired by the orchestrator once the queue unit merges. */
export function selectQueue(config: Config): Queue {
  throw new Error(`queue implementation not wired (QUEUE_IMPL=${config.queueImpl})`);
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<Server> {
  const config = loadConfig(env);
  const log = createLogger(config.logLevel, { service: 'api' });
  const auth = selectAuth(config);
  const queue = selectQueue(config);
  const db = createWriterDb(config);
  const dbReader = createReaderDb(config);
  const clock = systemClock;
  const deps: Deps = { db, dbReader, config, clock, auth, queue, log, metrics: emfMetrics(log, clock) };
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

/** Real path of p, or undefined when it does not exist. */
function realpathOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * True when argv1 (process.argv[1]) names the module at moduleUrl: compares real paths, so symlinked files or
 * directories match, and tolerates a missing `.js` extension (`node dist/api`).
 */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) {
    return false;
  }
  const modulePath = realpathOrUndefined(fileURLToPath(moduleUrl)) ?? fileURLToPath(moduleUrl);
  const candidates = [argv1, `${argv1}.js`];
  return candidates.some((c) => {
    const real = realpathOrUndefined(c);
    return real !== undefined && pathToFileURL(real).href === pathToFileURL(modulePath).href;
  });
}

const invokedDirectly = isMainModule(process.argv[1], import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
