// Scheduler (§8.3): tick runs due timers, records scheduled_runs, honours leadership; leader lock via GET_LOCK.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testConfig, testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps } from '../helpers/deps.js';
import { FixedClock } from '../helpers/clock.js';
import { createScheduler, startScheduler, timers } from '../../src/scheduler/index.js';
import { FakeQueue } from '../helpers/fakeQueue.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';
import { intervalSchedule } from '../../src/scheduler/schedule.js';
import { Leader, lockName } from '../../src/scheduler/leader.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

describe('scheduler', () => {
  it('registry has the four timers; only due_send runs on every worker', () => {
    const deps = makeTestDeps({ db });
    expect(timers(deps).map((t) => [t.name, t.leaderOnly])).toEqual([
      ['rescan', true],
      ['due_send', false],
      ['expiry', true],
      ['housekeeping', true],
    ]);
  });

  it('tick runs due timers, records status, skips leader-only when not leader, failure does not stop others', async () => {
    const clock = new FixedClock(new Date('2026-10-04T14:30:00Z'));
    const deps = makeTestDeps({ db, clock });
    const ran: string[] = [];
    const every = intervalSchedule(60);
    const s = createScheduler(
      deps,
      [
        { name: 'rescan', leaderOnly: true, schedule: every, run: async () => void ran.push('rescan') },
        {
          name: 'due_send',
          leaderOnly: false,
          schedule: every,
          run: async () => {
            throw new Error('x');
          },
        },
        { name: 'expiry', leaderOnly: false, schedule: every, run: async () => void ran.push('expiry') },
      ],
      { isLeader: () => false },
    );
    await s.tick(clock.now());
    expect(ran).toEqual(['expiry']);
    const rows = await db('scheduled_runs')
      .select('name', 'last_status', 'last_started_at', 'last_completed_at')
      .orderBy('name');
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.due_send.last_status).toBe('failed');
    expect(by.expiry).toMatchObject({
      last_status: 'ok',
      last_started_at: clock.now(),
      last_completed_at: clock.now(),
    });
    expect(by.rescan?.last_status ?? null).toBeNull();
  });

  it('leader lock: one holder per namespace, takeover after the holder dies, namespaces independent, name <= 64', async () => {
    const config = testConfig();
    const ns = `${config.resourceNamespace}-${Date.now()}`.padEnd(120, 'x');
    expect(lockName(ns).length).toBeLessThanOrEqual(64);
    const a = new Leader(config.databaseUrl, ns);
    const b = new Leader(config.databaseUrl, ns);
    const c = new Leader(config.databaseUrl, `${ns}-other`);
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(await c.tryAcquire()).toBe(true);
    await a.close();
    expect(await b.tryAcquire()).toBe(true);
    await b.close();
    await c.close();
  });
  it("leader takeover when the holder's connection dies (KILL, no RELEASE); the old holder notices it lost leadership", async () => {
    const config = testConfig();
    const ns = `${config.resourceNamespace}-kill-${Date.now()}`;
    const a = new Leader(config.databaseUrl, ns);
    const b = new Leader(config.databaseUrl, ns);
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(a.connectionId).toBeTypeOf('number');
    await db.raw('KILL ?', [a.connectionId ?? 0]);
    expect(await b.tryAcquire()).toBe(true);
    expect(await a.tryAcquire()).toBe(false);
    expect(a.isLeader()).toBe(false);
    await a.close();
    await b.close();
  });

  it('after stop() resolves nothing runs: no ticks, no housekeeping, lock released', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const config = {
        ...testConfig(),
        resourceNamespace: `${testConfig().resourceNamespace}-stop-${Date.now()}`,
      };
      const clock = new FixedClock();
      const queue = new FakeQueue();
      const deps = makeTestDeps({ db, config, clock, queue });
      const s = startScheduler(deps);
      await s.stop();
      const n = await makeNotification(db, 'filter', { active: true });
      const gone = await makeNotification(db, 'event', { active: false });
      await makeDelivery(db, {
        notification_id: gone.id,
        account_id: 1,
        sent_at: null,
        due_at: clock.now(),
        dedupe_key: 'x',
      });
      clock.advance(86_400_000);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(queue.enqueued).toEqual([]);
      expect(await db('notification_deliveries').count({ c: '*' }).first()).toMatchObject({ c: 1 });
      expect(await db('scheduled_runs').whereNotNull('last_started_at').pluck('name')).toEqual([]);
      const other = new Leader(config.databaseUrl, config.resourceNamespace);
      expect(await other.tryAcquire()).toBe(true);
      await other.close();
      expect(n.id).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
