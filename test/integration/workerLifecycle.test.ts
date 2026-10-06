// Worker lifecycle (§6): invalid cron fails before anything starts; stop deadline; /healthz and /readyz.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { testDb } from '../helpers/db.js';
import { makeTestDeps } from '../helpers/deps.js';
import { startWorker, stopWithDeadline, healthHandler, serveHealth, shutdownOnce } from '../../src/worker.js';
import { createLogger } from '../../src/lib/logger.js';
import type { Deps } from '../../src/lib/deps.js';

const db = testDb();
afterAll(() => db.destroy());

async function get(server: http.Server, path: string): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return res.status;
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('worker lifecycle', () => {
  it('an invalid HOUSEKEEPING_CRON rejects startWorker with nothing started', async () => {
    const base = makeTestDeps({ db });
    const deps: Deps = { ...base, config: { ...base.config, housekeepingCron: '1-5/x * * * *' } };
    const consume = vi.spyOn(deps.queue, 'consume');
    await expect(startWorker(deps)).rejects.toThrow(/invalid cron/);
    expect(consume).not.toHaveBeenCalled();
  });

  it('stopWithDeadline resolves "stopped" when stop finishes, "timeout" when the deadline fires first', async () => {
    const never = () => new Promise<void>(() => undefined);
    let fire: () => void = () => undefined;
    const timeout = stopWithDeadline(never, 30_000, (fn) => {
      fire = fn;
      return () => undefined;
    });
    fire();
    expect(await timeout).toBe('timeout');
    let cancelled = false;
    const ok = stopWithDeadline(
      async () => undefined,
      30_000,
      () => () => void (cancelled = true),
    );
    expect(await ok).toBe('stopped');
    expect(cancelled).toBe(true);
  });

  it('/healthz is 200; /readyz is 200 when the db ping works and 503 when it fails or not ready', async () => {
    expect(await get(http.createServer(healthHandler(db, () => true)), '/healthz')).toBe(200);
    expect(await get(http.createServer(healthHandler(db, () => true)), '/readyz')).toBe(200);
    const broken = { raw: () => Promise.reject(new Error('down')) } as unknown as typeof db;
    expect(await get(http.createServer(healthHandler(broken, () => true)), '/readyz')).toBe(503);
    expect(await get(http.createServer(healthHandler(db, () => false)), '/readyz')).toBe(503);
    expect(await get(http.createServer(healthHandler(db, () => true)), '/nope')).toBe(404);
  });

  /** startWorker with a consumer and scheduler whose stop() outcomes the test chooses. */
  async function workerWith(schedulerStop: () => Promise<void>, consumerStop: () => Promise<void>) {
    const deps = makeTestDeps({ db });
    const cStop = vi.fn(consumerStop);
    const sStop = vi.fn(schedulerStop);
    vi.spyOn(deps.queue, 'consume').mockResolvedValue({ stop: cStop });
    const worker = await startWorker(deps, { timers: [], startScheduler: () => ({ stop: sStop }) });
    return { worker, cStop, sStop };
  }

  it('stop() still stops the consumer when the scheduler stop rejects, then rethrows', async () => {
    const { worker, cStop, sStop } = await workerWith(
      async () => Promise.reject(new Error('scheduler stop failed')),
      async () => undefined,
    );
    await expect(worker.stop()).rejects.toThrow('scheduler stop failed');
    expect(sStop).toHaveBeenCalledTimes(1);
    expect(cStop).toHaveBeenCalledTimes(1);
  });

  it('stop() attempts both when both reject and rethrows the first error', async () => {
    const { worker, cStop } = await workerWith(
      async () => Promise.reject(new Error('scheduler stop failed')),
      async () => Promise.reject(new Error('consumer stop failed')),
    );
    await expect(worker.stop()).rejects.toThrow('scheduler stop failed');
    expect(cStop).toHaveBeenCalledTimes(1);
  });

  it('a health-server listen failure (EADDRINUSE) runs the orderly shutdown and exits non-zero', async () => {
    const first = http.createServer();
    await new Promise<void>((r) => first.listen(0, '127.0.0.1', r));
    const { port } = first.address() as AddressInfo;
    try {
      const stop = vi.fn(async () => undefined);
      let exited!: (code: number) => void;
      const exitCode = new Promise<number>((r) => (exited = r));
      const shutdown = shutdownOnce(stop, exited, createLogger('silent'));
      const errors: Array<NodeJS.ErrnoException> = [];
      const second = serveHealth(http.createServer(), port, '127.0.0.1', (err) => {
        errors.push(err);
        void shutdown(1);
      });
      expect(await exitCode).toBe(1);
      expect(errors[0]?.code).toBe('EADDRINUSE');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(second.listening).toBe(false);
    } finally {
      await new Promise((r) => first.close(r));
    }
  });
});
