// Leader lock robustness (§8.3): probes time out (leadership lost, close() resolves); a holder re-checks
// ownership instead of re-acquiring the re-entrant GET_LOCK.
import { describe, it, expect, afterAll } from 'vitest';
import type mysql from 'mysql2/promise';
import { testConfig, testDb } from '../helpers/db.js';
import mysqlp from 'mysql2/promise';
import { vi } from 'vitest';
import { makeTestDeps } from '../helpers/deps.js';
import { Leader, lockName } from '../../src/scheduler/leader.js';
import { createScheduler, type Timer } from '../../src/scheduler/index.js';
import { intervalSchedule } from '../../src/scheduler/schedule.js';

const db = testDb();
afterAll(() => db.destroy());

describe('leader', () => {
  it('a probe that never settles drops leadership at the timeout and close() still resolves', async () => {
    const config = testConfig();
    let hang = false;
    let destroyed = 0;
    const fakeConn = {
      on: () => undefined,
      query: () => (hang ? new Promise(() => undefined) : Promise.resolve([[{ got: 1, mine: 1 }]])),
      destroy: () => void destroyed++,
      end: () => new Promise(() => undefined),
      threadId: 1,
    } as unknown as mysql.Connection;
    const fired: Array<() => void> = [];
    const leader = new Leader(config.databaseUrl, `${config.resourceNamespace}-probe`, {
      connect: async () => fakeConn,
      setTimer: (fn) => {
        fired.push(fn);
        return () => undefined;
      },
    });
    expect(await leader.tryAcquire()).toBe(true);
    hang = true;
    const attempt = leader.tryAcquire();
    await Promise.resolve();
    fired.at(-1)!(); // the probe timeout elapses
    expect(await attempt).toBe(false);
    expect(leader.isLeader()).toBe(false);
    expect(destroyed).toBe(1);
    await expect(leader.close()).resolves.toBeUndefined();
  });

  it('a holder re-checks without raising the lock count', async () => {
    const config = testConfig();
    const ns = `${config.resourceNamespace}-reent-${process.pid}-${Date.now()}`;
    const leader = new Leader(config.databaseUrl, ns);
    try {
      expect(await leader.tryAcquire()).toBe(true);
      expect(await leader.tryAcquire()).toBe(true);
      expect(await leader.tryAcquire()).toBe(true);
      const conn = (leader as unknown as { conn: mysql.Connection }).conn;
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName(ns)]);
      const [rows] = await db.raw('SELECT IS_FREE_LOCK(?) AS free', [lockName(ns)]);
      expect((rows as Array<{ free: number }>)[0]!.free).toBe(1);
      // Ownership check notices the lock is gone, then re-acquires it.
      expect(await leader.tryAcquire()).toBe(false);
      expect(await leader.tryAcquire()).toBe(true);
    } finally {
      await leader.close();
    }
  });

  it('a leader whose lock was taken away (cached flag stale) does not start a leader-only timer', async () => {
    const config = testConfig();
    const ns = `${config.resourceNamespace}-kill-${process.pid}-${Date.now()}`;
    const leader = new Leader(config.databaseUrl, ns);
    const other = await mysqlp.createConnection({ uri: config.databaseUrl });
    const tag = `${process.pid}-${Date.now()}`;
    try {
      expect(await leader.tryAcquire()).toBe(true);
      // The lock leaves the leader without any connection event, as after a partition the server resolved.
      const conn = (leader as unknown as { conn: mysql.Connection }).conn;
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName(ns)]);
      const [rows] = await other.query('SELECT GET_LOCK(?, 0) AS got', [lockName(ns)]);
      expect((rows as Array<{ got: number }>)[0]!.got).toBe(1);
      expect(leader.isLeader()).toBe(true);
      const leaderRun = vi.fn(async () => undefined);
      const anyRun = vi.fn(async () => undefined);
      const list: Timer[] = [
        { name: `lo-${tag}`, leaderOnly: true, schedule: intervalSchedule(1), run: leaderRun },
        { name: `any-${tag}`, leaderOnly: false, schedule: intervalSchedule(1), run: anyRun },
      ];
      const deps = makeTestDeps({ db });
      const s = createScheduler(deps, list, {
        isLeader: () => leader.isLeader(),
        verifyLeader: () => leader.tryAcquire(),
      });
      await s.tick(new Date());
      expect(leaderRun).not.toHaveBeenCalled();
      expect(anyRun).toHaveBeenCalledTimes(1);
      expect(leader.isLeader()).toBe(false);
    } finally {
      await db('scheduled_runs')
        .whereIn('name', [`lo-${tag}`, `any-${tag}`])
        .delete();
      await other.end();
      await leader.close();
    }
  });

  it('a connection that opens after the connect timeout is destroyed, and the leader is not holding', async () => {
    const config = testConfig();
    let destroyed = 0;
    let ended = 0;
    const lateConn = {
      on: () => undefined,
      query: () => Promise.resolve([[{ got: 1, mine: 1 }]]),
      destroy: () => void destroyed++,
      end: () => (ended++, Promise.resolve()),
      threadId: 2,
    } as unknown as mysql.Connection;
    let open!: (c: mysql.Connection) => void;
    const fired: Array<() => void> = [];
    const leader = new Leader(config.databaseUrl, `${config.resourceNamespace}-slowconnect`, {
      connect: () => new Promise((r) => (open = r)),
      setTimer: (fn) => {
        fired.push(fn);
        return () => undefined;
      },
    });
    const attempt = leader.tryAcquire();
    await Promise.resolve();
    fired.at(-1)!(); // the connect timeout elapses
    expect(await attempt).toBe(false);
    open(lateConn); // the slow connect resolves afterwards
    await new Promise((r) => setImmediate(r));
    expect(destroyed + ended).toBeGreaterThanOrEqual(1);
    expect(leader.isLeader()).toBe(false);
    expect(leader.connectionId).toBeUndefined();
    await leader.close();
  });
});
