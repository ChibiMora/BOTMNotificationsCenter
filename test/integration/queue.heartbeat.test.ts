// Heartbeat against the real stand-in queue: rows-changed semantics must never turn "nothing changed" (same-second
// heartbeat) into "lease lost", while a genuinely lost lease still aborts.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { RecordingMetrics } from '../helpers/deps.js';
import { DbQueue } from '../../src/queue/dbQueue.js';
import type { JobHandlers, JobType } from '../../src/queue/queue.js';

const db = testDb();
const config = { ...testConfig(), queueImpl: 'db', jobMaxAttempts: 3 } as ReturnType<typeof testConfig>;
const TYPES: JobType[] = [
  'fanout_filter',
  'process_import',
  'event_delivery',
  'account_recheck',
  'cancel_scheduled',
];
let clock: FixedClock;

const handlersFor = (fn: (ctx: any) => Promise<void>) =>
  Object.fromEntries(TYPES.map((t) => [t, (_p: any, c: any) => fn(c)])) as JobHandlers;
const row = async () => db('jobs').first('status', 'locked_by', 'attempts');

/** Inserts one job, has worker A claim and run it with `fn`, and resolves when the attempt has settled. */
async function runWith(fn: (ctx: any) => Promise<void>): Promise<void> {
  await db('jobs').insert({ type: 'account_recheck', payload: '{}', run_at: clock.now() });
  const q = new DbQueue(config, {
    db,
    clock,
    log: createLogger('silent'),
    metrics: new RecordingMetrics(),
    workerId: 'A',
    manual: true,
  });
  await q.consume(handlersFor(fn), { onDead: async () => {} });
  expect(await q.runOnce()).toBe(1);
}

/** Runs a handler that lets `steal` change the row, then heartbeats; returns what the heartbeat threw. */
async function heartbeatAfter(steal: () => Promise<unknown>): Promise<unknown> {
  let hbError: unknown;
  await runWith(async (ctx) => {
    await steal();
    try {
      await ctx.heartbeat();
    } catch (e) {
      hbError = e;
      throw e;
    }
  });
  return hbError;
}

beforeEach(async () => {
  await resetDb(db);
  clock = new FixedClock(new Date('2026-10-04T14:30:00Z'));
});
afterAll(async () => {
  await db.destroy();
});

describe('dbQueue heartbeat', () => {
  it('a heartbeat in the same second as the claim (fixed clock) resolves and the job completes', async () => {
    let beats = 0;
    await runWith(async (ctx) => {
      await ctx.heartbeat();
      beats++;
    });
    expect(beats).toBe(1);
    expect(await row()).toEqual({ status: 'done', locked_by: null, attempts: 1 });
  });

  it('several heartbeats within one second all resolve', async () => {
    let beats = 0;
    await runWith(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.heartbeat();
        beats++;
        clock.advance(100);
      }
    });
    expect(beats).toBe(3);
    expect(await row()).toEqual({ status: 'done', locked_by: null, attempts: 1 });
  });

  it('a heartbeat after the clock advanced refreshes locked_at', async () => {
    let lockedAt: Date | undefined;
    await runWith(async (ctx) => {
      clock.advance(90_000);
      await ctx.heartbeat();
      lockedAt = (await db('jobs').first('locked_at'))?.locked_at;
    });
    expect(lockedAt?.getTime()).toBe(new Date('2026-10-04T14:31:30Z').getTime());
    expect((await row())?.status).toBe('done');
  });

  it('throws "lease lost" when the row was re-claimed by another worker', async () => {
    const e = await heartbeatAfter(() => db('jobs').update({ locked_by: 'B', attempts: 2 }));
    expect(String(e)).toMatch(/lease lost/);
    expect(await row()).toEqual({ status: 'running', locked_by: 'B', attempts: 2 });
  });

  it('throws "lease lost" when the row is no longer running', async () => {
    const e = await heartbeatAfter(() => db('jobs').update({ status: 'done', locked_by: null }));
    expect(String(e)).toMatch(/lease lost/);
    expect((await row())?.status).toBe('done');
  });

  it('throws "lease lost" when the attempt number changed under the same worker id', async () => {
    const e = await heartbeatAfter(() => db('jobs').update({ attempts: 2 }));
    expect(String(e)).toMatch(/lease lost/);
    expect(await row()).toEqual({ status: 'running', locked_by: 'A', attempts: 2 });
  });
});
