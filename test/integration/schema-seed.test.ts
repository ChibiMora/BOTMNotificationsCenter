import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { testConfig, testDb, resetDb, updateAccount } from '../helpers/db.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';
import { createDb } from '../../src/db/index.js';
import { makeTestDeps } from '../helpers/deps.js';
import { up as standinUp } from '../../migrations/20261001000000_standin_accounts.js';
import { seedAccounts, SEED_ACCOUNTS } from '../../scripts/seedAccounts.js';
import { loadConfig } from '../../src/config/index.js';
const db = testDb();
beforeAll(() => resetDb(db));
afterAll(() => db.destroy());
describe('migrations + seed', () => {
  it('seeds 72 accounts in documented order', async () => {
    const rows = await db('accounts')
      .orderBy('id')
      .select('id', 'country', 'policy', 'relationship_status', 'credits');
    expect(rows).toHaveLength(72);
    expect(rows[0]).toEqual({
      id: 1,
      country: 'US',
      policy: 'monthly',
      relationship_status: 'new_member',
      credits: 0,
    });
    expect(rows[5]).toEqual({
      id: 6,
      country: 'US',
      policy: 'monthly',
      relationship_status: 'new_member',
      credits: 10,
    });
    expect(rows[6]).toEqual({
      id: 7,
      country: 'US',
      policy: 'monthly',
      relationship_status: 'friend',
      credits: 0,
    });
    expect(rows[71]).toEqual({
      id: 72,
      country: 'CA',
      policy: 'annual',
      relationship_status: 'bff',
      credits: 10,
    });
    expect(SEED_ACCOUNTS).toHaveLength(72);
  });
  it('seed is idempotent; types and scheduled_runs seeded', async () => {
    await seedAccounts(db, testConfig());
    await seedAccounts(db, testConfig());
    expect((await db('accounts').count({ n: '*' }))[0]!.n).toBe(72);
    expect(await db('notification_types').orderBy('id').pluck('name')).toEqual(['filter', 'event', 'csv']);
    expect(await db('scheduled_runs').orderBy('name').pluck('name')).toEqual([
      'due_send',
      'expiry',
      'housekeeping',
      'rescan',
    ]);
  });
  it('db command: create applies migrations to an EMPTY database; migrate only migrates; drop removes; invalid names refused before reaching the server', async () => {
    const name = `${testConfig().dbName.slice(0, 64 - '_dbcmd'.length)}_dbcmd`;
    const run = (...a: string[]) =>
      execFileSync('npx', ['tsx', 'scripts/db.ts', ...a], {
        env: { ...process.env, STANDINS: 'true' },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    const exists = async (n: string) => (await db.raw('SHOW DATABASES LIKE ?', [n]))[0].length > 0;
    await db.raw(`DROP DATABASE IF EXISTS \`${name}\``);
    try {
      expect(await exists(name)).toBe(false);
      run('create', name);
      const other = createDb(loadConfig({ ...process.env, DB_NAME: name }).databaseUrl);
      try {
        const tables = (await other.raw('SHOW TABLES'))[0].map(
          (r: Record<string, string>) => Object.values(r)[0],
        );
        for (const t of [
          'accounts',
          'notifications',
          'notification_deliveries',
          'notification_types',
          'scheduled_runs',
        ])
          expect(tables).toContain(t);
        expect((await other('accounts').count({ n: '*' }))[0]!.n).toBe(72);
        await other('accounts').where({ id: 1 }).update({ credits: 99 });
        run('migrate', name);
        expect((await other('accounts').where({ id: 1 }).first()).credits).toBe(99);
      } finally {
        await other.destroy();
      }
      run('drop', name);
      expect(await exists(name)).toBe(false);
    } finally {
      await db.raw(`DROP DATABASE IF EXISTS \`${name}\``);
    }
    expect(() => run('create', 'bad-name')).toThrow();
    expect(() => run('drop', 'bad-name')).toThrow();
  });
  it('seedAccounts with standins false inserts nothing and reports it', async () => {
    await updateAccount(db, 1, { credits: 42 });
    const off = loadConfig({ ...process.env, STANDINS: 'false' });
    expect(await seedAccounts(db, off)).toBe(false);
    expect((await db('accounts').where({ id: 1 }).first()).credits).toBe(42);
    expect((await db('accounts').count({ n: '*' }))[0]!.n).toBe(72);
    await resetDb(db);
  });
  it('stand-in accounts migration refuses when accounts already exists', async () => {
    expect(process.env.STANDINS).toBe('true');
    await expect(standinUp(db)).rejects.toThrow(/accounts already exists/);
    expect((await db('accounts').count({ n: '*' }))[0]!.n).toBe(72);
  });
  it('resetDb restores seeded accounts, empties owned tables and keeps FK checks on for every pooled connection', async () => {
    await updateAccount(db, 5, { country: 'CA', credits: 77 });
    await db('accounts').insert({
      id: 500,
      country: 'US',
      policy: 'monthly',
      relationship_status: 'friend',
      credits: 0,
    });
    const n = await makeNotification(db, 'filter');
    await makeDelivery(db, { notification_id: n.id, account_id: 500 });
    await resetDb(db);
    const rows = await db('accounts')
      .orderBy('id')
      .select('id', 'country', 'policy', 'relationship_status', 'credits');
    expect(rows).toEqual(SEED_ACCOUNTS);
    for (const t of ['notifications', 'notification_deliveries', 'imports'])
      expect((await db(t).count({ n: '*' }))[0]!.n).toBe(0);
    expect(await db('scheduled_runs').whereNotNull('last_started_at').count({ n: '*' })).toEqual([{ n: 0 }]);
    expect((await db('scheduled_runs').count({ n: '*' }))[0]!.n).toBe(4);
    const n2 = await makeNotification(db, 'filter');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const attempts = Array.from({ length: 10 }, () =>
      db
        .transaction(async (trx) => {
          started++;
          if (started === 10) release();
          await gate;
          await makeDelivery(trx, { notification_id: n2.id, account_id: 99999 });
        })
        .then(
          () => 'inserted',
          (e: { code?: string }) => e.code,
        ),
    );
    expect(await Promise.all(attempts)).toEqual(Array(10).fill('ER_NO_REFERENCED_ROW_2'));
    await resetDb(db);
  });
  it('makeTestDeps reuses a passed db instead of opening a pool', () => {
    const deps = makeTestDeps({ db });
    expect(deps.db).toBe(db);
    expect(deps.dbReader).toBe(db);
  });
});
