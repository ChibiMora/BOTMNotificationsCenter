// Leader lock robustness (§8.3): probes time out (leadership lost, close() resolves); a holder re-checks
// ownership instead of re-acquiring the re-entrant GET_LOCK.
import { describe, it, expect, afterAll } from 'vitest';
import type mysql from 'mysql2/promise';
import { testConfig, testDb } from '../helpers/db.js';
import { Leader, lockName } from '../../src/scheduler/leader.js';

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
});
