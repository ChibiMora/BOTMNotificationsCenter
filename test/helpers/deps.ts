import type { Deps } from '../../src/lib/deps.js';
import type { Metrics, Dims } from '../../src/lib/metrics.js';
import { createLogger } from '../../src/lib/logger.js';
import { testConfig, testDb } from './db.js';
import { FixedClock } from './clock.js';
import { FakeQueue } from './fakeQueue.js';
export class RecordingMetrics implements Metrics {
  calls: Array<{ kind: string; name: string; value: number; dims?: Dims }> = [];
  count(name: string, value = 1, dims?: Dims) {
    this.calls.push({ kind: 'count', name, value, dims });
  }
  timing(name: string, value: number, dims?: Dims) {
    this.calls.push({ kind: 'timing', name, value, dims });
  }
  gauge(name: string, value: number, dims?: Dims) {
    this.calls.push({ kind: 'gauge', name, value, dims });
  }
}
/**
 * Test Deps: real db on DB_NAME, fixed clock, FakeQueue, stub auth (header-less: x-account-id), silent log.
 * Pass an existing `db` (and optionally `dbReader`) to share one pool across calls; when omitted a new pool is opened
 * and the caller must destroy `deps.db`.
 */
export function makeTestDeps(o: Partial<Deps> = {}): Deps {
  const config = o.config ?? testConfig();
  const db = o.db ?? testDb();
  const deps = {
    db,
    dbReader: db,
    config,
    clock: new FixedClock(),
    queue: new FakeQueue({ maxAttempts: config.jobMaxAttempts }),
    auth: {
      getSession: async (ctx: any) => {
        const id = Number(ctx.get?.('x-account-id'));
        return id > 0 ? { accountId: id } : null;
      },
      isAdmin: async (id: number) => config.adminAccountIds.includes(id),
    },
    log: createLogger('silent'),
    metrics: new RecordingMetrics(),
    ...o,
  } satisfies Deps;
  return deps;
}
