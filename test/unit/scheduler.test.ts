// Scheduler bookkeeping failures (§8.3): a failed scheduled_runs write never disables a timer or the scheduler.
import { describe, it, expect, vi } from 'vitest';
import { createScheduler, type Timer } from '../../src/scheduler/index.js';
import { intervalSchedule } from '../../src/scheduler/schedule.js';
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
});
