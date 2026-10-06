// Queue contract (§8.1, §10.2) via createQueue, plus dbQueue stand-in specifics and the jobs migration (§5.7).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { RecordingMetrics } from '../helpers/deps.js';
import { createQueue } from '../../src/queue/index.js';
import { DbQueue } from '../../src/queue/dbQueue.js';
import type { JobHandlers, JobType, Queue } from '../../src/queue/queue.js';

const db = testDb();
const db2 = testDb();
const config = { ...testConfig(), queueImpl: 'db', jobMaxAttempts: 3, fanoutMaxConcurrent: 2 } as ReturnType<
  typeof testConfig
>;
let clock: FixedClock;
const parts = (o: { db?: typeof db; workerId?: string } = {}) => ({
  db: o.db ?? db,
  clock,
  log: createLogger('silent'),
  metrics: new RecordingMetrics(),
  workerId: o.workerId ?? 'w1',
  manual: true,
});
const TYPES: JobType[] = [
  'fanout_filter',
  'process_import',
  'event_delivery',
  'account_recheck',
  'cancel_scheduled',
];
const handlersFor = (fn: (type: JobType, payload: any, ctx: any) => Promise<void>) =>
  Object.fromEntries(TYPES.map((t) => [t, (p: any, c: any) => fn(t, p, c)])) as JobHandlers;
const MIN = 60_000;

beforeEach(async () => {
  await resetDb(db);
  clock = new FixedClock(new Date('2026-10-04T14:30:00Z'));
});
afterAll(async () => {
  await db.destroy();
  await db2.destroy();
});

/** Drives one claim-and-run step through the configured implementation. */
const step = (q: Queue) => (q as unknown as { runOnce(): Promise<number> }).runOnce();

describe('queue contract (createQueue)', () => {
  it('delivers an enqueued job to its handler with its payload, including requestId', async () => {
    const q = createQueue(config, parts());
    const seen: any[] = [];
    await q
      .consume(
        handlersFor(async (t, p, c) => void seen.push({ t, p, a: c.attempt })),
        { onDead: async () => {} },
      )
      .then((h) => h.stop());
    await q.enqueue('account_recheck', { accountId: 7, requestId: 'req-1' });
    expect(await step(q)).toBe(1);
    expect(seen).toEqual([{ t: 'account_recheck', p: { accountId: 7, requestId: 'req-1' }, a: 1 }]);
    expect(await step(q)).toBe(0);
  });

  it('retries a throwing handler with backoff, then dead-letters once and never again', async () => {
    const q = createQueue(config, parts());
    const attempts: number[] = [];
    const dead: any[] = [];
    await (
      await q.consume(
        handlersFor(async (_t, _p, c) => {
          attempts.push(c.attempt);
          throw new Error('boom');
        }),
        { onDead: async (t, p, e) => void dead.push({ t, p, m: e.message }) },
      )
    ).stop();
    await q.enqueue('cancel_scheduled', { notificationId: 3 });
    expect(await step(q)).toBe(1);
    expect(await step(q)).toBe(0);
    clock.advance(2 * MIN - 1000);
    expect(await step(q)).toBe(0);
    clock.advance(1000);
    expect(await step(q)).toBe(1);
    clock.advance(4 * MIN);
    expect(await step(q)).toBe(1);
    expect(attempts).toEqual([1, 2, 3]);
    expect(dead).toEqual([{ t: 'cancel_scheduled', p: { notificationId: 3 }, m: 'boom' }]);
    clock.advance(10_000 * MIN);
    expect(await step(q)).toBe(0);
    expect(dead).toHaveLength(1);
  });

  it('does not deliver a job before its runAt', async () => {
    const q = createQueue(config, parts());
    await (
      await q.consume(
        handlersFor(async () => {}),
        { onDead: async () => {} },
      )
    ).stop();
    await q.enqueue(
      'fanout_filter',
      { notificationId: 1 },
      { runAt: new Date(clock.now().getTime() + 5 * MIN) },
    );
    expect(await step(q)).toBe(0);
    clock.advance(5 * MIN);
    expect(await step(q)).toBe(1);
  });

  it('createQueue throws for an unknown QUEUE_IMPL', () => {
    expect(() => createQueue({ ...config, queueImpl: 'sqs' } as any, parts())).toThrow(/no adapter/i);
  });
});

describe('dbQueue stand-in', () => {
  const job = (o: object = {}) =>
    db('jobs').insert({ type: 'account_recheck', payload: '{"accountId":1}', run_at: clock.now(), ...o });

  it('upkeep re-queues running jobs past the lease, keeps fresh ones', async () => {
    const q = new DbQueue(config, parts());
    const old = new Date(clock.now().getTime() - (config.jobLeaseMinutes + 1) * MIN);
    const [stale] = await job({ status: 'running', locked_at: old, locked_by: 'x', attempts: 1 });
    const [fresh] = await job({ status: 'running', locked_at: clock.now(), locked_by: 'x', attempts: 1 });
    await q.upkeep();
    const rows = await db('jobs').select('id', 'status').orderBy('id');
    expect(rows).toEqual([
      { id: stale, status: 'queued' },
      { id: fresh, status: 'running' },
    ]);
  });

  it('heartbeat keeps a long job from being re-queued', async () => {
    const q = new DbQueue(config, parts());
    await q.consume(
      handlersFor(async (_t, _p, c) => {
        clock.advance((config.jobLeaseMinutes + 5) * MIN);
        await c.heartbeat();
        await q.upkeep();
        const [r] = await db('jobs').select('status');
        expect(r.status).toBe('running');
      }),
      { onDead: async () => {} },
    );
    await q.enqueue('account_recheck', { accountId: 1 });
    expect(await q.runOnce()).toBe(1);
    expect((await db('jobs').first('status')).status).toBe('done');
  });

  it('two concurrent claimers on separate pools never take the same job', async () => {
    for (let i = 0; i < 20; i++) await job();
    const a = new DbQueue(config, parts({ workerId: 'a' }));
    const b = new DbQueue(config, parts({ db: db2, workerId: 'b' }));
    const [ca, cb] = await Promise.all([a.claim(), b.claim()]);
    const ids = [...ca, ...cb].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ca.length + cb.length).toBe(20);
  });

  it('upkeep deletes done rows older than 7 days and keeps newer', async () => {
    const q = new DbQueue(config, parts());
    const [, newer] = [
      await job({ status: 'done', locked_at: new Date(clock.now().getTime() - 8 * 1440 * MIN) }),
      await job({ status: 'done', locked_at: new Date(clock.now().getTime() - 6 * 1440 * MIN) }),
    ];
    await q.upkeep();
    expect((await db('jobs').select('id')).map((r) => r.id)).toEqual(newer);
  });

  it('purgeDead respects retention', async () => {
    const q = new DbQueue(config, parts());
    const days = config.deadJobRetentionDays;
    await job({ status: 'dead', locked_at: new Date(clock.now().getTime() - (days + 1) * 1440 * MIN) });
    const [keep] = await job({
      status: 'dead',
      locked_at: new Date(clock.now().getTime() - (days - 1) * 1440 * MIN),
    });
    expect(await q.purgeDead()).toBe(1);
    expect((await db('jobs').select('id')).map((r) => r.id)).toEqual([keep]);
  });

  it('caps concurrent fanout_filter jobs per worker', async () => {
    const q = new DbQueue(config, parts());
    let running = 0;
    let max = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const twoStarted = new Promise<void>((r) => (started = r));
    await q.consume(
      handlersFor(async () => {
        running++;
        max = Math.max(max, running);
        if (running === 2) started();
        await gate;
        running--;
      }),
      { onDead: async () => {} },
    );
    for (let i = 0; i < 3; i++) await q.enqueue('fanout_filter', { notificationId: i });
    const first = q.runOnce();
    await twoStarted;
    expect(await q.runOnce()).toBe(0);
    release();
    expect(await first).toBe(2);
    expect(await q.runOnce()).toBe(1);
    expect(max).toBe(2);
  });
});

describe('jobs migration', () => {
  it('creates jobs with the §5.7 columns and claim index', async () => {
    const [cols] = await db.raw('SHOW COLUMNS FROM jobs');
    expect(cols.map((c: any) => c.Field)).toEqual([
      'id',
      'type',
      'payload',
      'run_at',
      'attempts',
      'status',
      'locked_by',
      'locked_at',
      'last_error',
      'created_at',
    ]);
    const [idx] = await db.raw("SHOW INDEX FROM jobs WHERE Key_name = 'idx_jobs_claim'");
    expect(idx.map((i: any) => i.Column_name)).toEqual(['status', 'run_at']);
  });
  it('after stop() resolves the poll loop is gone: an enqueued job is not run, upkeep does nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const q = new DbQueue(config, { ...parts(), manual: false });
    let ran = 0;
    const c = await q.consume(
      handlersFor(async () => void ran++),
      { onDead: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(10);
    await c.stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    vi.useRealTimers();
    await q.enqueue('event_delivery', { x: 1 } as never);
    await db('jobs').insert({
      type: 'event_delivery',
      payload: '{}',
      run_at: clock.now(),
      status: 'running',
      locked_by: 'gone',
      locked_at: new Date(clock.now().getTime() - 60 * MIN),
    });
    clock.advance(60 * MIN);
    expect(await q.runOnce()).toBe(0);
    await q.upkeep();
    expect(ran).toBe(0);
    expect(await db('jobs').orderBy('id').pluck('status')).toEqual(['queued', 'running']);
  });
});
