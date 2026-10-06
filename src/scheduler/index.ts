// Timer registry and scheduler (§8.3). tick(now) runs due timers and records scheduled_runs from the app clock;
// leader-only timers run only while this process holds the leader lock (leader.ts).
// Ownership is re-verified against MySQL immediately before each tick starts a leader-only run, but a brief
// two-leader window (lock lost right after the check) cannot be fully excluded: leader-only timers MUST be idempotent.
// Catch-up: on becoming leader the scheduler reads scheduled_runs.last_started_at once; a leader-only timer whose most
// recent due time (Schedule.previousDue) is later than its last start runs once at the next tick — one run for the most
// recent missed due time, never one per missed occurrence. A timer that never started anywhere (NULL) is not caught up.
import type { Deps } from '../lib/deps.js';
import type { Schedule } from './schedule.js';
import { Leader } from './leader.js';
import { rescanTimer } from './rescan.js';
import { dueSendTimer } from './dueSend.js';
import { expiryTimer } from './expiry.js';
import { housekeepingTimer } from './housekeeping.js';

export interface Timer {
  name: string;
  leaderOnly: boolean;
  schedule: Schedule;
  run(deps: Deps): Promise<void>;
}

const TICK_MS = 1000;
const LEADER_RETRY_MS = 30_000;

export const timers = (deps: Deps): Timer[] => [
  rescanTimer(deps),
  dueSendTimer(deps),
  expiryTimer(deps),
  housekeepingTimer(deps),
];

export interface LeaderGate {
  /** Cached leadership flag (cheap; may be stale). */
  isLeader(): boolean;
  /** Confirms with the database that this process still holds the lock; called before starting leader-only runs. */
  verifyLeader?(): Promise<boolean>;
}

export function createScheduler(deps: Deps, list: Timer[], opts: LeaderGate) {
  const lastStarted = new Map<string, Date>();
  const inFlight = new Set<string>();
  /** last_started_at per timer as read from scheduled_runs when this process last became leader. */
  const recorded = new Map<string, Date>();
  let wasLeader = false;
  let loading: Promise<void> | undefined;

  const loadRecordedStarts = async () => {
    recorded.clear();
    try {
      const rows: Array<{ name: string; last_started_at: Date | null }> = await deps
        .db('scheduled_runs')
        .select('name', 'last_started_at');
      for (const r of rows) if (r.last_started_at) recorded.set(r.name, new Date(r.last_started_at));
    } catch (e) {
      // No catch-up this leadership stint; scheduled runs are unaffected.
      deps.log.error({ err: e }, 'timer bookkeeping failed');
    }
  };

  /** The missed due time to catch up for a leader-only timer, or undefined when nothing was missed. */
  const missedDue = (t: Timer, now: Date): Date | undefined => {
    const a = lastStarted.get(t.name);
    const b = recorded.get(t.name);
    const last = a === undefined ? b : b === undefined || a > b ? a : b;
    if (last === undefined) return undefined;
    const due = t.schedule.previousDue(now);
    return due !== undefined && due > last ? due : undefined;
  };

  const record = (name: string, fields: Record<string, unknown>) =>
    deps
      .db('scheduled_runs')
      .insert({ name, ...fields })
      .onConflict('name')
      .merge(Object.keys(fields));

  const runTimer = async (t: Timer, now: Date) => {
    lastStarted.set(t.name, now);
    if (inFlight.has(t.name)) {
      deps.metrics.count('scheduled_run', 1, { name: t.name, status: 'skipped' });
      await record(t.name, { last_status: 'skipped' });
      return;
    }
    // Cleared in `finally`, so a failed bookkeeping write can never leave the timer marked in flight.
    inFlight.add(t.name);
    let status = 'ok';
    try {
      await record(t.name, { last_started_at: now }).catch((e) => bookkeepingFailed(t, e));
      await t.run(deps);
    } catch (e) {
      status = 'failed';
      deps.log.error({ err: e, timer: t.name }, 'timer failed');
      deps.metrics.count('timer_failed', 1, { name: t.name });
    } finally {
      inFlight.delete(t.name);
    }
    deps.metrics.count('scheduled_run', 1, { name: t.name, status });
    await record(t.name, { last_completed_at: deps.clock.now(), last_status: status }).catch((e) =>
      bookkeepingFailed(t, e),
    );
  };

  const bookkeepingFailed = (t: Timer, e: unknown) =>
    deps.log.error({ err: e, timer: t.name }, 'timer bookkeeping failed');

  return {
    /** Starts every due timer; resolves when they have all finished. A failing timer never stops the others. */
    async tick(now: Date): Promise<void> {
      const leader = list.some((t) => t.leaderOnly) && opts.isLeader();
      if (leader && !wasLeader) loading = loadRecordedStarts();
      wasLeader = leader;
      if (leader && loading) await loading;
      const catchUp = new Map<string, Date>();
      let due = list.filter((t) => {
        if (t.leaderOnly && !leader) return false;
        if (t.schedule.isDue(now, lastStarted.get(t.name))) return true;
        const missed = t.leaderOnly ? missedDue(t, now) : undefined;
        if (missed) catchUp.set(t.name, missed);
        return missed !== undefined;
      });
      // Not the holder any more: leader-only timers are left alone, exactly as on a non-leader (nothing recorded).
      if (due.some((t) => t.leaderOnly) && opts.verifyLeader) {
        const mine = await opts.verifyLeader().catch(() => false);
        if (!mine) due = due.filter((t) => !t.leaderOnly);
      }
      for (const t of due) {
        const missed = catchUp.get(t.name);
        if (missed) deps.log.info({ timer: t.name, missedDueAt: missed }, 'timer catch-up');
      }
      await Promise.all(
        due.map((t) =>
          runTimer(t, now).catch((e) =>
            deps.log.error({ err: e, timer: t.name }, 'timer bookkeeping failed'),
          ),
        ),
      );
    },
  };
}

/** Real timers: tick every second, leader attempt every 30 s. stop() clears both, waits for the in-flight tick and
 * leader attempt, then releases the lock and closes its connection; nothing runs after it resolves. */
export function startScheduler(deps: Deps, list: Timer[] = timers(deps)): { stop(): Promise<void> } {
  const leader = new Leader(deps.config.databaseUrl, deps.config.resourceNamespace);
  let stopped = false;
  const scheduler = createScheduler(deps, list, {
    isLeader: () => !stopped && leader.isLeader(),
    verifyLeader: async () => !stopped && (await leader.tryAcquire()) && !stopped,
  });
  const ticking = new Set<Promise<void>>();
  void leader.tryAcquire();
  const leaderTimer = setInterval(() => void leader.tryAcquire(), LEADER_RETRY_MS);
  const tickTimer = setInterval(() => {
    if (stopped) return;
    const t: Promise<void> = scheduler.tick(deps.clock.now()).finally(() => ticking.delete(t));
    ticking.add(t);
  }, TICK_MS);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(leaderTimer);
      clearInterval(tickTimer);
      await Promise.all(ticking);
      await leader.close();
    },
  };
}
