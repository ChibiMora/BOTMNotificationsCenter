// Scheduler bookkeeping failures (§8.3): a failed scheduled_runs write never disables a timer or the scheduler.
import { describe, it, expect, vi } from 'vitest';
import { createScheduler, type Timer } from '../../src/scheduler/index.js';
import { cronSchedule, intervalSchedule } from '../../src/scheduler/schedule.js';
import type { Deps } from '../../src/lib/deps.js';

/** A db whose scheduled_runs upsert fails when `shouldFail(fields)` says so. */
function fakeDeps(shouldFail: (fields: Record<string, unknown>) => boolean): Deps {
  const db = () => ({
    insert: (row: Record<string, unknown>) => ({
      onConflict: () => ({
        merge: () => (shouldFail(row) ? Promise.reject(new Error('db blip')) : Promise.resolve()),
      }),
    }),
  });
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    db,
    log,
    metrics: { count: vi.fn() },
    clock: { now: () => new Date('2026-10-04T14:30:00Z') },
  } as unknown as Deps;
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 4, 14, 30, s));

describe('scheduler bookkeeping', () => {
  it('a failed start write does not leave the timer marked in flight', async () => {
    let failures = 1;
    const deps = fakeDeps((row) => 'last_started_at' in row && failures-- > 0);
    const run = vi.fn(async () => undefined);
    const timer: Timer = {
      name: 't',
      leaderOnly: false,
      schedule: intervalSchedule(1),
      run,
    };
    const s = createScheduler(deps, [timer], { isLeader: () => true });
    await s.tick(at(0));
    await s.tick(at(1));
    await s.tick(at(2));
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a failing final write does not throw out of tick nor block other timers', async () => {
    const deps = fakeDeps((row) => row.name === 'a' && 'last_status' in row);
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    const s = createScheduler(
      deps,
      [
        { name: 'a', leaderOnly: false, schedule: intervalSchedule(1), run: a },
        { name: 'b', leaderOnly: false, schedule: intervalSchedule(1), run: b },
      ],
      { isLeader: () => true },
    );
    await expect(s.tick(at(0))).resolves.toBeUndefined();
    await expect(s.tick(at(1))).resolves.toBeUndefined();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('a leader whose ownership check now fails does not start a leader-only timer; others still run', async () => {
    const recorded: string[] = [];
    const deps = fakeDeps((row) => (recorded.push(String(row.name)), false));
    const leaderRun = vi.fn(async () => undefined);
    const anyRun = vi.fn(async () => undefined);
    const list: Timer[] = [
      { name: 'leader', leaderOnly: true, schedule: intervalSchedule(1), run: leaderRun },
      { name: 'any', leaderOnly: false, schedule: intervalSchedule(1), run: anyRun },
    ];
    // The cached flag still says leader, but the lock is no longer ours.
    const verifyLeader = vi.fn(async () => false);
    const s = createScheduler(deps, list, { isLeader: () => true, verifyLeader });
    await s.tick(at(0));
    expect(verifyLeader).toHaveBeenCalled();
    expect(leaderRun).not.toHaveBeenCalled();
    expect(anyRun).toHaveBeenCalledTimes(1);
    expect(recorded).not.toContain('leader');
  });
});

/** Catch-up (§8.3): a db whose scheduled_runs read returns `rows`; upserts are recorded in `writes`. */
function catchupDeps(rows: Array<{ name: string; last_started_at: Date | null }>) {
  const writes: Array<Record<string, unknown>> = [];
  const reads = { count: 0 };
  const db = () => ({
    select: () => (reads.count++, Promise.resolve(rows)),
    insert: (row: Record<string, unknown>) => ({
      onConflict: () => ({ merge: () => (writes.push(row), Promise.resolve()) }),
    }),
  });
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const deps = {
    db,
    log,
    metrics: { count: vi.fn() },
    clock: { now: () => new Date('2026-10-06T13:00:00Z') },
  } as unknown as Deps;
  return { deps, writes, reads, log };
}

const expiryAt1 = (run: () => Promise<void>): Timer => ({
  name: 'expiry',
  leaderOnly: true,
  schedule: cronSchedule('0 1 * * *'),
  run,
});

describe('scheduler catch-up of the most recent missed due time', () => {
  const now = new Date('2026-10-06T13:00:00Z');
  const next = new Date('2026-10-06T13:00:01Z');

  it('(a) leader, last started yesterday 01:00: runs once on the first tick, not again on the next', async () => {
    const { deps, writes, reads, log } = catchupDeps([
      { name: 'expiry', last_started_at: new Date('2026-10-05T01:00:00Z') },
    ]);
    const run = vi.fn(async () => undefined);
    const s = createScheduler(deps, [expiryAt1(run)], { isLeader: () => true });
    await s.tick(now);
    await s.tick(next);
    await s.tick(new Date('2026-10-06T14:00:00Z'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(reads.count).toBe(1);
    expect(writes).toContainEqual({ name: 'expiry', last_started_at: now });
    expect(log.info).toHaveBeenCalledWith(
      { timer: 'expiry', missedDueAt: new Date('2026-10-06T01:00:00Z') },
      'timer catch-up',
    );
  });

  it('(b) last started after the most recent due time: nothing runs', async () => {
    const { deps } = catchupDeps([{ name: 'expiry', last_started_at: new Date('2026-10-06T01:00:02Z') }]);
    const run = vi.fn(async () => undefined);
    const s = createScheduler(deps, [expiryAt1(run)], { isLeader: () => true });
    await s.tick(now);
    expect(run).not.toHaveBeenCalled();
  });

  it('(c) never run anywhere (NULL): no catch-up, runs at the scheduled minute', async () => {
    const { deps } = catchupDeps([{ name: 'expiry', last_started_at: null }]);
    const run = vi.fn(async () => undefined);
    const s = createScheduler(deps, [expiryAt1(run)], { isLeader: () => true });
    await s.tick(now);
    await s.tick(next);
    expect(run).not.toHaveBeenCalled();
    await s.tick(new Date('2026-10-07T01:00:00Z'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('(d) a worker down for 7 days: exactly one catch-up run', async () => {
    const { deps } = catchupDeps([{ name: 'expiry', last_started_at: new Date('2026-09-29T01:00:00Z') }]);
    const run = vi.fn(async () => undefined);
    const s = createScheduler(deps, [expiryAt1(run)], { isLeader: () => true });
    for (let i = 0; i < 10; i++) await s.tick(new Date(now.getTime() + i * 1000));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('(e) non-leader: no catch-up and no read', async () => {
    const { deps, reads } = catchupDeps([
      { name: 'expiry', last_started_at: new Date('2026-10-04T01:00:00Z') },
    ]);
    const run = vi.fn(async () => undefined);
    const s = createScheduler(deps, [expiryAt1(run)], { isLeader: () => false });
    await s.tick(now);
    expect(run).not.toHaveBeenCalled();
    expect(reads.count).toBe(0);
  });

  it('(f) verifyLeader false: no catch-up run, nothing recorded', async () => {
    const { deps, writes } = catchupDeps([
      { name: 'expiry', last_started_at: new Date('2026-10-04T01:00:00Z') },
    ]);
    const run = vi.fn(async () => undefined);
    const verifyLeader = vi.fn(async () => false);
    const s = createScheduler(deps, [expiryAt1(run)], { isLeader: () => true, verifyLeader });
    await s.tick(now);
    expect(verifyLeader).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('a failed read logs bookkeeping failure and falls back to no catch-up', async () => {
    const { deps, log } = catchupDeps([]);
    (deps as { db: unknown }).db = () => ({
      select: () => Promise.reject(new Error('db blip')),
    });
    const run = vi.fn(async () => undefined);
    const s = createScheduler(deps, [expiryAt1(run)], { isLeader: () => true });
    await expect(s.tick(now)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.anything(), 'timer bookkeeping failed');
  });
});
