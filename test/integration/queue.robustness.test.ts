// Stand-in queue robustness (§8.1): upkeep failures do not stop claiming; concurrent claims respect the in-flight and
// fan-out caps; exhausted queued rows are dead-lettered; a wake-up during poll() is not lost.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { RecordingMetrics } from '../helpers/deps.js';
import { DbQueue } from '../../src/queue/dbQueue.js';
import type { JobHandlers, JobType } from '../../src/queue/queue.js';

const db = testDb();
const config = { ...testConfig(), queueImpl: 'db', jobMaxAttempts: 3, fanoutMaxConcurrent: 2 } as ReturnType<
  typeof testConfig
>;
let clock: FixedClock;
const parts = (o: { manual?: boolean; wait?: (ms: number) => Promise<void> } = {}) => ({
  db,
  clock,
  log: createLogger('silent'),
  metrics: new RecordingMetrics(),
  workerId: 'w1',
  manual: o.manual ?? true,
  wait: o.wait,
});
const TYPES: JobType[] = [
  'event_delivery',
  'fanout_filter',
  'process_import',
  'cancel_scheduled',
  'account_recheck',
];
const handlersFor = (fn: (type: JobType) => Promise<void>) =>
  Object.fromEntries(TYPES.map((t) => [t, () => fn(t)])) as unknown as JobHandlers;

beforeEach(async () => {
  await resetDb(db);
  clock = new FixedClock(new Date('2026-10-04T14:30:00Z'));
});
afterAll(() => db.destroy());

describe('stand-in queue robustness', () => {
  it('a persistently failing upkeep does not stop jobs being claimed and run', async () => {
    let waits = 0;
    let giveUp!: () => void;
    const tooMany = new Promise<'stuck'>((r) => (giveUp = () => r('stuck')));
    // Yields to the event loop instead of sleeping; caps the iterations so a stuck loop fails rather than hangs.
    const wait = () => new Promise<void>((r) => setImmediate(() => (++waits > 50 ? giveUp() : r())));
    const q = new DbQueue(config, parts({ manual: false, wait }));
    vi.spyOn(q, 'upkeep').mockRejectedValue(new Error('Lock wait timeout exceeded'));
    await q.enqueue('event_delivery', { n: 1 });
    let ran!: () => void;
    const done = new Promise<'ran'>((r) => (ran = () => r('ran')));
    const c = await q.consume(
      handlersFor(async () => ran()),
      { onDead: async () => {} },
    );
    expect(await Promise.race([done, tooMany])).toBe('ran');
    await c.stop();
  });

  it('concurrent poll() calls never exceed 10 in flight nor the fan-out cap', async () => {
    const q = new DbQueue(config, parts());
    for (let i = 0; i < 15; i++) await q.enqueue('event_delivery', { i });
    for (let i = 0; i < 5; i++) await q.enqueue('fanout_filter', { i });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let running = 0;
    let fanouts = 0;
    let maxRunning = 0;
    let maxFanouts = 0;
    await q.consume(
      handlersFor(async (t) => {
        running++;
        if (t === 'fanout_filter') fanouts++;
        maxRunning = Math.max(maxRunning, running);
        maxFanouts = Math.max(maxFanouts, fanouts);
        await gate;
        running--;
        if (t === 'fanout_filter') fanouts--;
      }),
      { onDead: async () => {} },
    );
    const counts = await Promise.all(Array.from({ length: 8 }, () => q.poll()));
    const claimed = counts.reduce((a, b) => a + b, 0);
    const { n } = (await db('jobs').where('status', 'running').count({ n: '*' }).first()) as { n: number };
    const { f } = (await db('jobs')
      .where({ status: 'running', type: 'fanout_filter' })
      .count({ f: '*' })
      .first()) as {
      f: number;
    };
    expect(claimed).toBe(10);
    expect(Number(n)).toBe(10);
    expect(Number(f)).toBeLessThanOrEqual(2);
    release();
    await q.drain();
    expect(maxRunning).toBeLessThanOrEqual(10);
    expect(maxFanouts).toBeLessThanOrEqual(2);
  });

  it('upkeep dead-letters a queued row whose attempts reached JOB_MAX_ATTEMPTS, calling onDead exactly once', async () => {
    const q = new DbQueue(config, parts());
    await q.enqueue('cancel_scheduled', { notificationId: 9 });
    await db('jobs').update({ attempts: config.jobMaxAttempts });
    const onDead = vi.fn(async () => {});
    await q.consume(
      handlersFor(async () => {}),
      { onDead },
    );
    await q.upkeep();
    await q.upkeep();
    const row = await db('jobs').first('status', 'last_error');
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/attempts/);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledWith('cancel_scheduled', { notificationId: 9 }, expect.any(Error));
  });

  /** A loop whose injected sleep never elapses on its own: records each sleep and signals the first one. */
  const sleepRecorder = () => {
    const sleeps: number[] = [];
    let slept!: () => void;
    const firstSleep = new Promise<void>((r) => (slept = r));
    const wait = (ms: number) => {
      sleeps.push(ms);
      slept();
      return new Promise<void>(() => undefined);
    };
    return { sleeps, firstSleep, wait };
  };

  it('a job settling while the loop is inside poll() makes the next wait return at once', async () => {
    const { sleeps, firstSleep, wait } = sleepRecorder();
    const q = new DbQueue(config, parts({ manual: false, wait }));
    await q.enqueue('event_delivery', { n: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inFlight = () => [...(q as unknown as { inFlight: Set<Promise<void>> }).inFlight];
    let polls = 0;
    vi.spyOn(q, 'poll').mockImplementation(async () => {
      polls++;
      const claimed = await DbQueue.prototype.poll.call(q);
      if (polls === 2) {
        // The job claimed by poll 1 settles while poll 2 is still running.
        expect(claimed).toBe(0);
        const running = inFlight();
        release();
        await Promise.all(running);
      }
      return claimed;
    });
    const c = await q.consume(
      handlersFor(() => gate),
      { onDead: async () => {} },
    );
    await firstSleep;
    // Poll 1 claimed the job (no wait); poll 2 claimed nothing, but the wake-up during it skipped the wait;
    // only poll 3 sleeps a full interval.
    expect(polls).toBe(3);
    expect(sleeps).toEqual([config.queuePollSeconds * 1000]);
    await c.stop();
  });

  it('without a wake-up the loop waits the poll interval after an empty poll', async () => {
    const { sleeps, firstSleep, wait } = sleepRecorder();
    const q = new DbQueue(config, parts({ manual: false, wait }));
    const poll = vi.spyOn(q, 'poll');
    const c = await q.consume(
      handlersFor(async () => undefined),
      { onDead: async () => {} },
    );
    await firstSleep;
    expect(poll).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([config.queuePollSeconds * 1000]);
    await c.stop();
  });
});
