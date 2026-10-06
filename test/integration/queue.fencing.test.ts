// dbQueue stand-in: lease fencing, dead-letter exactly once, non-blocking concurrency, error isolation, backoff (§8.1, §8.4).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Knex } from 'knex';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { RecordingMetrics } from '../helpers/deps.js';
import { DbQueue } from '../../src/queue/dbQueue.js';
import type { JobHandlers, JobType } from '../../src/queue/queue.js';

const db = testDb();
const config = {
  ...testConfig(),
  queueImpl: 'db',
  jobMaxAttempts: 3,
  fanoutMaxConcurrent: 2,
} as ReturnType<typeof testConfig>;
const MIN = 60_000;
const TYPES: JobType[] = [
  'fanout_filter',
  'process_import',
  'event_delivery',
  'account_recheck',
  'cancel_scheduled',
];
let clock: FixedClock;

const parts = (
  o: {
    db?: Knex;
    workerId?: string;
    manual?: boolean;
    wait?: (ms: number) => Promise<void>;
  } = {},
) => ({
  db: o.db ?? db,
  clock,
  log: createLogger('silent'),
  metrics: new RecordingMetrics(),
  workerId: o.workerId ?? 'w1',
  manual: o.manual ?? true,
  ...(o.wait ? { wait: o.wait } : {}),
});
const handlersFor = (fn: (type: JobType, payload: any, ctx: any) => Promise<void>) =>
  Object.fromEntries(TYPES.map((t) => [t, (p: any, c: any) => fn(t, p, c)])) as JobHandlers;
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 1000; i++) {
    if (await f()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('until: condition never met');
};
const statusIs =
  (status: string, n = 1) =>
  async () =>
    (await db('jobs').where('status', status).count({ c: '*' }))[0]!.c === n;
const lockedBy = (w: string) => async () => (await db('jobs').first('locked_by'))?.locked_by === w;
const row = async () => db('jobs').first('status', 'locked_by', 'attempts');

beforeEach(async () => {
  await resetDb(db);
  clock = new FixedClock(new Date('2026-10-04T14:30:00Z'));
});
afterAll(async () => {
  await db.destroy();
});

/** Worker A claims a job, stalls past the lease; worker B re-claims it. Returns A's gate and B's pending run. */
async function stolenLease(startAttempts = 0) {
  await db('jobs').insert({
    type: 'account_recheck',
    payload: '{}',
    run_at: clock.now(),
    attempts: startAttempts,
  });
  const aGate = deferred();
  const bGate = deferred();
  const deadA: string[] = [];
  const deadB: string[] = [];
  const a = new DbQueue(config, parts({ workerId: 'A' }));
  const b = new DbQueue(config, parts({ workerId: 'B' }));
  await a.consume(
    handlersFor(() => aGate.promise),
    { onDead: async () => void deadA.push('A') },
  );
  await b.consume(
    handlersFor(() => bGate.promise),
    { onDead: async () => void deadB.push('B') },
  );
  const aRun = a.runOnce();
  await until(lockedBy('A'));
  clock.advance((config.jobLeaseMinutes + 1) * MIN);
  await b.upkeep();
  return { a, b, aGate, bGate, aRun, deadA, deadB };
}

describe('dbQueue lease fencing', () => {
  it("old owner's late success leaves the new owner's row untouched", async () => {
    const { b, aGate, bGate, aRun } = await stolenLease();
    const bRun = b.runOnce();
    await until(lockedBy('B'));
    aGate.resolve();
    await aRun;
    expect(await row()).toEqual({
      status: 'running',
      locked_by: 'B',
      attempts: 2,
    });
    bGate.resolve();
    await bRun;
    expect((await row())?.status).toBe('done');
  });

  it("old owner's late failure does not re-queue the new owner's row", async () => {
    const { b, aGate, bGate, aRun, deadA } = await stolenLease();
    const bRun = b.runOnce();
    await until(lockedBy('B'));
    aGate.reject(new Error('late'));
    await aRun;
    expect(await row()).toEqual({
      status: 'running',
      locked_by: 'B',
      attempts: 2,
    });
    expect(deadA).toEqual([]);
    bGate.resolve();
    await bRun;
  });

  it("old owner's late final failure: no dead-letter over the new owner's row", async () => {
    // attempts start at 1 -> A runs attempt 2 (not final), B re-claims as attempt 3 (final).
    const { b, aGate, bGate, aRun, deadA, deadB } = await stolenLease(1);
    const bRun = b.runOnce();
    await until(lockedBy('B'));
    expect(await row()).toEqual({
      status: 'running',
      locked_by: 'B',
      attempts: 3,
    });
    aGate.reject(new Error('late'));
    await aRun;
    expect(await row()).toEqual({
      status: 'running',
      locked_by: 'B',
      attempts: 3,
    });
    bGate.reject(new Error('final'));
    await bRun;
    expect((await row())?.status).toBe('dead');
    expect([...deadA, ...deadB]).toEqual(['B']);
  });

  it('a stalled final attempt is dead-lettered by upkeep once and never run a 4th time', async () => {
    const { b, aGate, aRun, deadA, deadB } = await stolenLease(2);
    expect(await row()).toEqual({
      status: 'dead',
      locked_by: null,
      attempts: 3,
    });
    expect(deadB).toEqual(['B']);
    await b.upkeep();
    expect(await b.runOnce()).toBe(0);
    aGate.reject(new Error('late'));
    await aRun;
    expect(deadA).toEqual([]);
    expect(deadB).toEqual(['B']);
    expect(await row()).toEqual({
      status: 'dead',
      locked_by: null,
      attempts: 3,
    });
  });

  it('never claims a queued job with no attempts left', async () => {
    await db('jobs').insert({
      type: 'account_recheck',
      payload: '{}',
      run_at: clock.now(),
      attempts: 3,
    });
    const q = new DbQueue(config, parts());
    await q.consume(
      handlersFor(async () => {}),
      { onDead: async () => {} },
    );
    expect(await q.runOnce()).toBe(0);
  });

  it('heartbeat after the lease was lost throws "lease lost"', async () => {
    await db('jobs').insert({
      type: 'account_recheck',
      payload: '{}',
      run_at: clock.now(),
    });
    const gate = deferred();
    let hbError: unknown;
    const a = new DbQueue(config, parts({ workerId: 'A' }));
    await a.consume(
      handlersFor(async (_t, _p, ctx) => {
        await gate.promise;
        try {
          await ctx.heartbeat();
        } catch (e) {
          hbError = e;
          throw e;
        }
      }),
      { onDead: async () => {} },
    );
    const run = a.runOnce();
    await until(lockedBy('A'));
    clock.advance((config.jobLeaseMinutes + 1) * MIN);
    const b = new DbQueue(config, parts({ workerId: 'B' }));
    await b.upkeep();
    gate.resolve();
    await run;
    expect(String(hbError)).toMatch(/lease lost/);
    expect((await row())?.status).toBe('queued');
  });
});

describe('dbQueue concurrency (non-blocking poll)', () => {
  it('fan-outs ahead of other jobs never block them; cap counts in-flight fan-outs; long jobs do not block claims', async () => {
    for (let i = 0; i < 12; i++)
      await db('jobs').insert({
        type: 'fanout_filter',
        payload: `{"n":${i}}`,
        run_at: clock.now(),
      });
    await db('jobs').insert({
      type: 'event_delivery',
      payload: '{"n":99}',
      run_at: clock.now(),
    });
    const gates = new Map<number, ReturnType<typeof deferred>>();
    const p = parts();
    const q = new DbQueue(config, p);
    await q.consume(
      handlersFor((_t, p) => {
        const d = deferred();
        gates.set(p.n, d);
        return d.promise;
      }),
      { onDead: async () => {} },
    );
    expect(await q.poll()).toBe(3);
    const running = () => db('jobs').where('status', 'running').orderBy('id').pluck('type');
    expect(await running()).toEqual(['fanout_filter', 'fanout_filter', 'event_delivery']);
    expect(await q.poll()).toBe(0);
    gates.get(0)!.resolve();
    // The job has settled (slot freed) once run() recorded its duration.
    await until(async () => p.metrics.calls.some((c) => c.name === 'job_duration_ms'));
    expect(await q.poll()).toBe(1);
    expect(await running()).toEqual(['fanout_filter', 'fanout_filter', 'event_delivery']);
    await db('jobs').insert({
      type: 'account_recheck',
      payload: '{"n":100}',
      run_at: clock.now(),
    });
    expect(await q.poll()).toBe(1);
    for (const g of gates.values()) g.resolve();
    await q.drain();
  });

  it('stop() resolves only after in-flight handlers settle, and nothing is claimed afterwards', async () => {
    await db('jobs').insert({
      type: 'event_delivery',
      payload: '{}',
      run_at: clock.now(),
    });
    const gate = deferred();
    const started = deferred();
    let ran = 0;
    const q = new DbQueue(config, parts({ manual: false, wait: () => new Promise(() => {}) }));
    const c = await q.consume(
      handlersFor(async () => {
        ran++;
        started.resolve();
        await gate.promise;
      }),
      { onDead: async () => {} },
    );
    await started.promise;
    let stopped = false;
    const s = c.stop().then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false);
    await db('jobs').insert({
      type: 'event_delivery',
      payload: '{}',
      run_at: clock.now(),
    });
    gate.resolve();
    await s;
    await flush();
    expect(ran).toBe(1);
    expect(await db('jobs').orderBy('id').pluck('status')).toEqual(['done', 'queued']);
  });
});

/** A knex whose `update({status})` fails for the given status, or whose first `failures` calls throw. */
function flakyDb(o: { failStatus?: string; failures?: number }) {
  let left = o.failures ?? 0;
  const boom = () => {
    left--;
    throw new Error('db unreachable');
  };
  return new Proxy(db, {
    apply(target, thisArg, args) {
      if (left > 0) boom();
      const qb = Reflect.apply(target, thisArg, args);
      const update = qb.update.bind(qb);
      qb.update = (v: any, ...rest: any[]) =>
        o.failStatus && v?.status === o.failStatus ? Promise.reject(new Error('blip')) : update(v, ...rest);
      return qb;
    },
    get(target, prop, recv) {
      if (prop === 'transaction' && left > 0) return () => Promise.reject(boom());
      return Reflect.get(target, prop, recv);
    },
  }) as Knex;
}

describe('dbQueue error isolation', () => {
  it('a failed done write does not turn a successful job into a failure', async () => {
    await db('jobs').insert({
      type: 'account_recheck',
      payload: '{}',
      run_at: clock.now(),
    });
    const dead: string[] = [];
    const q = new DbQueue(config, parts({ db: flakyDb({ failStatus: 'done' }) }));
    await q.consume(
      handlersFor(async () => {}),
      { onDead: async () => void dead.push('x') },
    );
    expect(await q.runOnce()).toBe(1);
    expect(await row()).toEqual({
      status: 'running',
      locked_by: 'w1',
      attempts: 1,
    });
    expect(dead).toEqual([]);
  });

  it('a throwing onDead is caught: the job stays dead and siblings finish', async () => {
    await db('jobs').insert({
      type: 'account_recheck',
      payload: '{"n":1}',
      run_at: clock.now(),
      attempts: 2,
    });
    await db('jobs').insert({
      type: 'account_recheck',
      payload: '{"n":2}',
      run_at: clock.now(),
    });
    const sibling = deferred();
    let siblingDone = false;
    const q = new DbQueue(config, parts());
    await q.consume(
      handlersFor(async (_t, p) => {
        if (p.n === 1) throw new Error('final');
        await sibling.promise;
        siblingDone = true;
      }),
      { onDead: async () => Promise.reject(new Error('onDead broke')) },
    );
    const r = q.runOnce();
    await until(statusIs('dead'));
    sibling.resolve();
    expect(await r).toBe(2);
    expect(siblingDone).toBe(true);
    expect(await db('jobs').orderBy('id').pluck('status')).toEqual(['dead', 'done']);
  });

  it('poll loop backs off while the database is unreachable and resumes when it recovers', async () => {
    await db('jobs').insert({
      type: 'account_recheck',
      payload: '{}',
      run_at: clock.now(),
    });
    const delays: number[] = [];
    const done = deferred();
    const q = new DbQueue(
      config,
      parts({
        db: flakyDb({ failures: 4 }),
        manual: false,
        wait: async (ms) => {
          delays.push(ms);
          if (delays.length >= 6) await new Promise(() => {});
        },
      }),
    );
    const c = await q.consume(
      handlersFor(async () => done.resolve()),
      { onDead: async () => {} },
    );
    await done.promise;
    await flush();
    await c.stop();
    const base = config.queuePollSeconds * 1000;
    expect(delays.slice(0, 4)).toEqual([base, base * 2, base * 4, base * 8].map((d) => Math.min(d, 60_000)));
    expect(delays.slice(4).every((d) => d === base)).toBe(true);
    expect((await row())?.status).toBe('done');
  });
});
