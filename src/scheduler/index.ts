// Timer registry and scheduler (§8.3). tick(now) runs due timers and records scheduled_runs from the app clock;
// leader-only timers run only while this process holds the leader lock (leader.ts).
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

export function createScheduler(deps: Deps, list: Timer[], opts: { isLeader(): boolean }) {
  const lastStarted = new Map<string, Date>();
  const inFlight = new Set<string>();

  const record = (name: string, fields: Record<string, unknown>) =>
    deps
      .db('scheduled_runs')
      .insert({ name, ...fields })
      .onConflict('name')
      .merge(Object.keys(fields));

  const runTimer = async (t: Timer, now: Date) => {
    lastStarted.set(t.name, now);
    if (inFlight.has(t.name)) {
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
      deps.metrics.count('timer_failed', 1, { timer: t.name });
    } finally {
      inFlight.delete(t.name);
    }
    await record(t.name, { last_completed_at: deps.clock.now(), last_status: status }).catch((e) =>
      bookkeepingFailed(t, e),
    );
  };

  const bookkeepingFailed = (t: Timer, e: unknown) =>
    deps.log.error({ err: e, timer: t.name }, 'timer bookkeeping failed');

  return {
    /** Starts every due timer; resolves when they have all finished. A failing timer never stops the others. */
    async tick(now: Date): Promise<void> {
      const due = list.filter(
        (t) => (!t.leaderOnly || opts.isLeader()) && t.schedule.isDue(now, lastStarted.get(t.name)),
      );
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
  const scheduler = createScheduler(deps, list, { isLeader: () => !stopped && leader.isLeader() });
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
