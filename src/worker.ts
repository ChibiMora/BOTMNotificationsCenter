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
  /** Starts the scheduler (default: the real startScheduler; tests inject one). */
  startScheduler?: (deps: Deps, list: Timer[]) => { stop(): Promise<void> };
}

/** Starts consuming and (optionally) the scheduler; stop() ends both, waiting for in-progress work. */
export async function startWorker(deps: Deps, opts: WorkerOptions = {}): Promise<{ stop(): Promise<void> }> {
  // Build (and so validate) the timers first: an invalid cron rejects before any consumer or leader connection.
  const list = opts.scheduler === false ? undefined : (opts.timers ?? timers(deps));
  const consumer = await deps.queue.consume(opts.handlers ?? jobHandlers(deps), { onDead: onDead(deps) });
  const scheduler = list && (opts.startScheduler ?? startScheduler)(deps, list);
  return {
    // Both are always attempted, so a failing scheduler stop never leaves the consumer claiming; first error wins.
    stop: async () => {
      const results = await Promise.allSettled([
        scheduler ? scheduler.stop() : Promise.resolve(),
        consumer.stop(),
      ]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
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

/** Returns a shutdown function that runs `stop` once under the deadline and then calls `exit`: `code` on a clean
 * stop, 1 on a timeout or failure. Later calls return the first call's promise. */
export function shutdownOnce(
  stop: () => Promise<void>,
  exit: (code: number) => void,
  log: Deps['log'],
  deadlineMs = STOP_DEADLINE_MS,
): (code?: number) => Promise<void> {
  let running: Promise<void> | undefined;
  return (code = 0) =>
    (running ??= (async () => {
      log.info('worker shutting down');
      try {
        const result = await stopWithDeadline(stop, deadlineMs);
        if (result === 'timeout') {
          log.error({ deadlineMs }, 'worker stop deadline exceeded');
          return exit(1);
        }
        exit(code);
      } catch (err) {
        log.error({ err }, 'worker shutdown failed');
        exit(1);
      }
    })());
}

/** Listens on `port`; a server error (e.g. EADDRINUSE) goes to `onError` instead of crashing the process. */
export function serveHealth(
  server: http.Server,
  port: number,
  host: string | undefined,
  onError: (err: NodeJS.ErrnoException) => void,
): http.Server {
  server.on('error', onError);
  if (host) server.listen(port, host);
  else server.listen(port);
  return server;
}

/** /healthz: process alive. /readyz: ready and the writer answers a ping. */
export function healthHandler(
  db: Pick<Deps['db'], 'raw'>,
  isReady: () => boolean,
  metrics?: Pick<Deps['metrics'], 'count'>,
): http.RequestListener {
  return async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.url === '/readyz') {
      // Not ready while shutting down gracefully is expected (every deploy): only a failed ping is counted.
      const ok =
        isReady() &&
        (await db.raw('SELECT 1').then(
          () => true,
          () => {
            metrics?.count('readiness_failed', 1, { process: 'worker' });
            return false;
          },
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
  const server = http.createServer(healthHandler(db, () => ready, metrics));
  const stopAll = shutdownOnce(
    async () => {
      ready = false;
      server.close();
      await worker.stop();
      await db.destroy();
      await dbReader.destroy();
    },
    (code) => process.exit(code),
    log,
  );
  serveHealth(server, config.workerHealthPort, undefined, (err) => {
    log.error({ err, port: config.workerHealthPort }, 'worker health server failed');
    void stopAll(1);
  });
  const shutdown = () => void stopAll(0);
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
