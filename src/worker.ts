// Worker composition root (§6): builds Deps, consumes jobs from the handler registry, runs the timer registry,
// serves /healthz and /readyz on WORKER_HEALTH_PORT. Importing this module starts nothing.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/index.js';
import { createReaderDb, createWriterDb } from './db/index.js';
import { systemClock } from './lib/clock.js';
import type { Deps } from './lib/deps.js';
import { createLogger } from './lib/logger.js';
import { emfMetrics } from './lib/metrics.js';
import { createQueue } from './queue/index.js';
import { jobHandlers, onDead } from './jobs/index.js';
import { startScheduler, timers, type Timer } from './scheduler/index.js';
import type { JobHandlers } from './queue/queue.js';

export interface WorkerOptions {
  /** Start the timer registry (default true). */
  scheduler?: boolean;
  /** Handler map to consume with (default: the real registry jobHandlers(deps)). */
  handlers?: JobHandlers;
  /** Timer list to schedule (default: the real registry timers(deps)). */
  timers?: Timer[];
}

/** Starts consuming and (optionally) the scheduler; stop() ends both, waiting for in-progress work. */
export async function startWorker(deps: Deps, opts: WorkerOptions = {}): Promise<{ stop(): Promise<void> }> {
  // Build (and so validate) the timers first: an invalid cron rejects before any consumer or leader connection.
  const list = opts.scheduler === false ? undefined : (opts.timers ?? timers(deps));
  const consumer = await deps.queue.consume(opts.handlers ?? jobHandlers(deps), { onDead: onDead(deps) });
  const scheduler = list && startScheduler(deps, list);
  return {
    stop: async () => {
      await scheduler?.stop();
      await consumer.stop();
    },
  };
}

/** How long shutdown may take before the process gives up and exits non-zero. */
export const STOP_DEADLINE_MS = 30_000;

/** Runs `stop`, racing it against a deadline; `setTimer` returns a cancel function (tests inject it). */
export async function stopWithDeadline(
  stop: () => Promise<void>,
  ms: number,
  setTimer: (fn: () => void, ms: number) => () => void = (fn, delay) => {
    const t = setTimeout(fn, delay);
    return () => clearTimeout(t);
  },
): Promise<'stopped' | 'timeout'> {
  let cancel = () => undefined as void;
  const deadline = new Promise<'timeout'>((resolve) => {
    cancel = setTimer(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([stop().then(() => 'stopped' as const), deadline]);
  } finally {
    cancel();
  }
}

/** /healthz: process alive. /readyz: ready and the writer answers a ping. */
export function healthHandler(db: Pick<Deps['db'], 'raw'>, isReady: () => boolean): http.RequestListener {
  return async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.url === '/readyz') {
      const ok =
        isReady() &&
        (await db.raw('SELECT 1').then(
          () => true,
          () => false,
        ));
      res.writeHead(ok ? 200 : 503).end(ok ? 'ready' : 'not ready');
      return;
    }
    res.writeHead(404).end();
  };
}

async function main() {
  const config = loadConfig(process.env);
  const log = createLogger(config.logLevel, { service: 'worker' });
  const clock = systemClock;
  const db = createWriterDb(config);
  const dbReader = createReaderDb(config);
  const metrics = emfMetrics(log, clock);
  const queue = createQueue(config, { db, clock, log, metrics });
  const auth = { getSession: async () => null, isAdmin: async () => false };
  const deps: Deps = { db, dbReader, config, clock, auth, queue, log, metrics };
  const worker = await startWorker(deps);
  let ready = true;
  const server = http.createServer(healthHandler(db, () => ready));
  server.listen(config.workerHealthPort);
  const shutdown = async () => {
    ready = false;
    log.info('worker shutting down');
    server.close();
    try {
      const result = await stopWithDeadline(async () => {
        await worker.stop();
        await db.destroy();
        await dbReader.destroy();
      }, STOP_DEADLINE_MS);
      if (result === 'timeout') {
        log.error({ deadlineMs: STOP_DEADLINE_MS }, 'worker stop deadline exceeded');
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'worker shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  log.info({ port: config.workerHealthPort }, 'worker started');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // The logger may not exist yet (config failure), so write to stderr directly.
    console.error('worker failed to start', err);
    process.exit(1);
  });
}
