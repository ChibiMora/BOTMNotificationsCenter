// resetDb's guard: a transaction leaked by a previous test is killed and named, never turned into a hang.
import { describe, it, expect, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { testDb, testConfig, resetDb, leakedTransactions } from '../helpers/db.js';

const db = testDb();
afterAll(() => db.destroy());

const connectionId = async (k: ReturnType<typeof testDb>) =>
  Number((await k.raw('SELECT CONNECTION_ID() AS id'))[0][0].id);
/** Is thread `id` still a session of THIS database? */
const alive = async (id: number) =>
  Number(
    (
      await db.raw(
        'SELECT COUNT(*) AS c FROM information_schema.processlist WHERE ID = ? AND DB = DATABASE()',
        [id],
      )
    )[0][0].c,
  ) === 1;

describe('resetDb leak guard', () => {
  it('kills a leaked idle transaction, fails naming it, and the next reset succeeds', async () => {
    await resetDb(db);
    // The leaker is a raw mysql2 connection, not a knex pool: once the guard kills it server-side, a knex
    // transaction's rollback and its pool's destroy() both wait on that dead connection being released, which
    // mysql2 may never report. conn.destroy() just closes the socket, so this clean-up cannot block.
    const leaker = await mysql.createConnection({ uri: testConfig().databaseUrl });
    leaker.on('error', () => undefined); // the guard's KILL closes this socket; that is the expected outcome
    const idle = testDb();
    try {
      const idleId = await connectionId(idle); // pooled, no transaction: must survive
      await leaker.beginTransaction();
      await leaker.query('SELECT id FROM accounts WHERE id = 1 FOR UPDATE');
      const [[{ id }]] = (await leaker.query('SELECT CONNECTION_ID() AS id')) as unknown as [
        [{ id: number }],
      ];
      const leakedId = Number(id);
      // The server answers a statement before it marks the session 'Sleep', so for a moment the leaker can still
      // be listed as mid-statement (which the guard rightly ignores). Poll until the guard's own query sees it.
      await expect
        .poll(async () => (await leakedTransactions(db)).map((l) => l.thread), { timeout: 2000, interval: 5 })
        .toContain(leakedId);

      await expect(resetDb(db)).rejects.toThrow(
        new RegExp(`transaction was leaked by the previous test.*thread ${leakedId}: open \\d+s`),
      );
      expect(await alive(leakedId)).toBe(false);
      expect(await alive(idleId)).toBe(true);
      expect(await leakedTransactions(db)).toEqual([]);

      await expect(resetDb(db)).resolves.toBeUndefined();
    } finally {
      leaker.destroy(); // synchronous socket close: never awaits a dead connection
      await idle.destroy();
    }
  });

  it('leaves a session that is mid-statement alone, even inside a transaction', async () => {
    await resetDb(db);
    const holder = await mysql.createConnection({ uri: testConfig().databaseUrl });
    const busy = await mysql.createConnection({ uri: testConfig().databaseUrl });
    holder.on('error', () => undefined);
    busy.on('error', () => undefined);
    try {
      // GET_LOCK names are server-wide: scope this one to the database so other runs never share it.
      const [[{ name: lock }]] = (await holder.query(
        "SELECT CONCAT(DATABASE(), ':resetGuard') AS name",
      )) as unknown as [[{ name: string }]];
      await holder.query('SELECT GET_LOCK(?, 0)', [lock]);
      await busy.beginTransaction();
      const [[{ id }]] = (await busy.query('SELECT CONNECTION_ID() AS id')) as unknown as [[{ id: number }]];
      const busyId = Number(id);
      const waiting = busy.query('SELECT GET_LOCK(?, 30) AS got', [lock]); // blocks until holder releases
      waiting.catch(() => undefined);
      const command = async () =>
        (
          await db.raw(
            'SELECT COMMAND AS c FROM information_schema.processlist WHERE ID = ? AND DB = DATABASE()',
            [busyId],
          )
        )[0][0]?.c;
      await expect.poll(command, { timeout: 2000, interval: 5 }).toBe('Query');

      await expect(resetDb(db)).resolves.toBeUndefined();
      expect(await alive(busyId)).toBe(true);

      await holder.query('SELECT RELEASE_LOCK(?)', [lock]);
      expect(Number(((await waiting) as unknown as [[{ got: number }]])[0][0].got)).toBe(1);
      await busy.rollback();
    } finally {
      holder.destroy();
      busy.destroy();
    }
  });
});
