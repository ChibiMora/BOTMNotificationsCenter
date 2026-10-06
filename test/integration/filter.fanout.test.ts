// fanout_filter (§7.2 steps 5–7, §8.2 row; B7, B8, B17) against the real database and seeded accounts 1–72.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Knex } from 'knex';
import { testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { FixedClock } from '../helpers/clock.js';
import { makeNotification } from '../helpers/factories.js';
import { fanoutFilter } from '../../src/jobs/fanoutFilter.js';
import type { Deps } from '../../src/lib/deps.js';
import type { JobContext } from '../../src/queue/queue.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

const C = ['US', 'CA'];
const P = ['monthly', 'annual'];
const S = ['new_member', 'friend', 'bff'];
const CR = [0, 1, 2, 3, 5, 10];
/** Seed layout: credits vary fastest, then status, policy, country. */
const seedIds = (pred: (c: string, p: string, s: string, cr: number) => boolean) => {
  const ids: number[] = [];
  C.forEach((c, ci) =>
    P.forEach((p, pi) =>
      S.forEach((s, si) =>
        CR.forEach((cr, k) => {
          if (pred(c, p, s, cr)) ids.push(1 + ((ci * 2 + pi) * 3 + si) * 6 + k);
        }),
      ),
    ),
  );
  return ids;
};
const ALL = seedIds(() => true);
const ctx = (heartbeat: () => Promise<void> = async () => {}): JobContext => ({ attempt: 1, heartbeat });
const rows = (nid: number) =>
  db('notification_deliveries').where({ notification_id: nid }).orderBy('account_id');
const ids = async (nid: number) => (await rows(nid)).map((r) => r.account_id);
const FAR = 20_001;
const addFarAccount = () =>
  db('accounts').insert({
    id: FAR,
    country: 'US',
    policy: 'monthly',
    relationship_status: 'friend',
    credits: 1,
    created_at: new Date(),
  });

describe('fanout_filter', () => {
  it('delivers exactly the eligible accounts, live, keyed by month, sent_at = due_at = the clock instant', async () => {
    const metrics = new RecordingMetrics();
    const deps = makeTestDeps({ db, metrics });
    const filters = { country: ['CA'], relationshipStatus: ['friend', 'bff'], credits: { minimum: 1 } };
    const n = await makeNotification(db, 'filter', { active: true, filters: JSON.stringify(filters) });
    await fanoutFilter(deps, { notificationId: n.id }, ctx());
    const expected = seedIds((c, _p, s, cr) => c === 'CA' && (s === 'friend' || s === 'bff') && cr >= 1);
    expect(expected).toEqual([
      44, 45, 46, 47, 48, 50, 51, 52, 53, 54, 62, 63, 64, 65, 66, 68, 69, 70, 71, 72,
    ]);
    const got = await rows(n.id);
    expect(got.map((r) => r.account_id)).toEqual(expected);
    const t = deps.clock.now().getTime();
    for (const r of got) {
      expect(r.dedupe_key).toBe('2026-10');
      expect(new Date(r.sent_at).getTime()).toBe(t);
      expect(new Date(r.due_at).getTime()).toBe(t);
    }
    expect(metrics.calls.some((c) => c.kind === 'count' && c.value === expected.length)).toBe(true);
  });

  it('{} filters delivers to all 72 accounts', async () => {
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', { active: true, filters: JSON.stringify({}) });
    await fanoutFilter(deps, { notificationId: n.id }, ctx());
    expect(await ids(n.id)).toEqual(ALL);
  });

  it('running twice, or twice concurrently, produces no duplicates', async () => {
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', { active: true });
    await fanoutFilter(deps, { notificationId: n.id }, ctx());
    await fanoutFilter(deps, { notificationId: n.id }, ctx());
    expect(await ids(n.id)).toEqual(ALL);
    const m = await makeNotification(db, 'filter', { active: true });
    await Promise.all([
      fanoutFilter(deps, { notificationId: m.id }, ctx()),
      fanoutFilter(deps, { notificationId: m.id }, ctx()),
    ]);
    expect(await ids(m.id)).toEqual(ALL);
  });

  it('a new month produces a second delivery under the new key; the first month is untouched', async () => {
    const clock = new FixedClock();
    const deps = makeTestDeps({ db, clock });
    const n = await makeNotification(db, 'filter', {
      active: true,
      filters: JSON.stringify({ policy: ['annual'] }),
    });
    await fanoutFilter(deps, { notificationId: n.id }, ctx());
    const before = await rows(n.id);
    clock.set('2026-11-01T00:05:00Z');
    await fanoutFilter(deps, { notificationId: n.id }, ctx());
    const after = await rows(n.id);
    const annual = seedIds((_c, p) => p === 'annual');
    expect(after.filter((r) => r.dedupe_key === '2026-10')).toEqual(before);
    const nov = after.filter((r) => r.dedupe_key === '2026-11');
    expect(nov.map((r) => r.account_id)).toEqual(annual);
    for (const r of nov) expect(new Date(r.sent_at).toISOString()).toBe('2026-11-01T00:05:00.000Z');
  });

  it('stops when deactivated mid-run', async () => {
    await addFarAccount();
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', { active: true });
    await fanoutFilter(
      deps,
      { notificationId: n.id },
      ctx(async () => {
        await db('notifications').where({ id: n.id }).update({ active: false });
      }),
    );
    expect(await ids(n.id)).toEqual(ALL);
  });

  it('stops when removed mid-run', async () => {
    await addFarAccount();
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', { active: true });
    await fanoutFilter(
      deps,
      { notificationId: n.id },
      ctx(async () => {
        await db('notifications').where({ id: n.id }).update({ removed: true });
      }),
    );
    expect(await ids(n.id)).toEqual(ALL);
  });

  it('control: with no interruption the far account range is reached', async () => {
    await addFarAccount();
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', { active: true });
    await fanoutFilter(deps, { notificationId: n.id }, ctx());
    expect(await ids(n.id)).toEqual([...ALL, FAR]);
  });

  it('stops without inserting under the old key when the month changes mid-run', async () => {
    await addFarAccount();
    const clock = new FixedClock(new Date('2026-10-31T23:59:59Z'));
    const deps = makeTestDeps({ db, clock });
    const n = await makeNotification(db, 'filter', { active: true });
    await fanoutFilter(
      deps,
      { notificationId: n.id },
      ctx(async () => clock.set('2026-11-01T00:00:00Z')),
    );
    const got = await rows(n.id);
    expect(got.map((r) => r.account_id)).toEqual(ALL);
    expect(new Set(got.map((r) => r.dedupe_key))).toEqual(new Set(['2026-10']));
  });

  it('missing, inactive, removed or non-filter notification: no rows, no error', async () => {
    const deps = makeTestDeps({ db });
    const inactive = await makeNotification(db, 'filter', { active: false });
    const removed = await makeNotification(db, 'filter', { active: true, removed: true });
    const event = await makeNotification(db, 'event', { active: true });
    for (const id of [999_999, inactive.id, removed.id, event.id]) {
      await fanoutFilter(deps, { notificationId: id }, ctx());
    }
    expect(await db('notification_deliveries').count({ n: '*' }).first()).toEqual({ n: 0 });
  });

  it('reads eligibility through dbReader; an account deleted between selection and insert is skipped', async () => {
    const reader = testDb();
    let selections = 0;
    const wrapped = new Proxy(reader, {
      apply(target, thisArg, args: unknown[]) {
        const qb = Reflect.apply(target, thisArg, args) as Knex.QueryBuilder;
        const then = qb.then.bind(qb);
        (qb as any).then = (ok: any, ko: any) =>
          then(async (res: unknown) => {
            if (/not exists/i.test(qb.toSQL().sql)) {
              selections++;
              await db('accounts').where({ id: 5 }).delete();
            }
            return res;
          }).then(ok, ko);
        return qb;
      },
    }) as Knex;
    try {
      const deps: Deps = makeTestDeps({ db, dbReader: wrapped });
      const n = await makeNotification(db, 'filter', { active: true });
      await fanoutFilter(deps, { notificationId: n.id }, ctx());
      expect(selections).toBeGreaterThan(0);
      expect(await ids(n.id)).toEqual(ALL.filter((id) => id !== 5));
    } finally {
      await reader.destroy();
    }
  });
});

/**
 * A replica handle over a real connection that refuses every write (insert/update/delete/transaction) and can run a
 * hook after each eligibility selection (the `not exists` query) or reject every query.
 */
const guardedReader = (o: { afterSelection?: (n: number) => Promise<void>; reject?: Error } = {}) => {
  const reader = testDb();
  let selections = 0;
  const writeRefused = () => {
    throw new Error('write through dbReader');
  };
  const wrapped = new Proxy(reader, {
    apply(target, thisArg, args: unknown[]) {
      const qb = Reflect.apply(target, thisArg, args) as Knex.QueryBuilder;
      for (const m of ['insert', 'update', 'delete', 'del', 'truncate', 'upsert'])
        (qb as any)[m] = writeRefused;
      const then = qb.then.bind(qb);
      (qb as any).then = (ok: any, ko: any) => {
        if (o.reject) return Promise.reject(o.reject).then(ok, ko);
        return then(async (res: unknown) => {
          if (/not exists/i.test(qb.toSQL().sql)) {
            selections++;
            await o.afterSelection?.(selections);
          }
          return res;
        }).then(ok, ko);
      };
      return qb;
    },
    get(target, p, recv) {
      if (p === 'transaction' || p === 'insert' || p === 'raw') return writeRefused;
      return Reflect.get(target, p, recv);
    },
  }) as Knex;
  return { wrapped, reader, selections: () => selections };
};
const account = (id: number) => ({
  id,
  country: 'US',
  policy: 'monthly',
  relationship_status: 'friend',
  credits: 1,
  created_at: new Date(),
});

describe('fanout_filter: review fixes', () => {
  it('no write goes through dbReader; every delivery is written through the writer', async () => {
    const g = guardedReader();
    try {
      const deps = makeTestDeps({ db, dbReader: g.wrapped });
      const n = await makeNotification(db, 'filter', { active: true });
      await fanoutFilter(deps, { notificationId: n.id }, ctx());
      expect(g.selections()).toBeGreaterThan(0);
      expect(await ids(n.id)).toEqual(ALL);
    } finally {
      await g.reader.destroy();
    }
  });

  it('credits maximum 3 includes credits = 3 and excludes credits = 5', async () => {
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', {
      active: true,
      filters: JSON.stringify({ credits: { maximum: 3 } }),
    });
    await fanoutFilter(deps, { notificationId: n.id }, ctx());
    const got = await ids(n.id);
    // Each group of six is credits 0,1,2,3,5,10: ids 1–4 of the first group are in, 5 (credits 5) and 6 are out.
    expect(got.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(got).not.toContain(5);
    expect(got).not.toContain(6);
    expect(got).toHaveLength(48);
    expect(got).toEqual(seedIds((_c, _p, _s, cr) => cr <= 3));
  });

  it('a sparse id space: one range iteration per occupied range (3), not one per 10,000 ids', async () => {
    await db('accounts').insert([account(FAR), account(1_000_000_000)]);
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', { active: true });
    let beats = 0;
    await fanoutFilter(
      deps,
      { notificationId: n.id },
      ctx(async () => void beats++),
    );
    expect(await ids(n.id)).toEqual([...ALL, FAR, 1_000_000_000]);
    expect(beats).toBe(3);
  });

  it('an account created above the highest id while the job is mid-run is picked up', async () => {
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', { active: true });
    let beats = 0;
    await fanoutFilter(
      deps,
      { notificationId: n.id },
      ctx(async () => {
        if (++beats === 1) await db('accounts').insert(account(50_000));
      }),
    );
    expect(await ids(n.id)).toEqual([...ALL, 50_000]);
  });

  it('deactivated between the selection of a range and its insert: nothing from that range is written', async () => {
    // 10,001 is in the second range whichever way ranges are stepped, so that range's selection is non-empty.
    await db('accounts').insert(account(10_001));
    const deps0 = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', { active: true });
    const g = guardedReader({
      afterSelection: async (k) => {
        if (k === 2) await db('notifications').where({ id: n.id }).update({ active: false });
      },
    });
    try {
      await fanoutFilter({ ...deps0, dbReader: g.wrapped }, { notificationId: n.id }, ctx());
      expect(g.selections()).toBe(2);
      expect(await ids(n.id)).toEqual(ALL);
    } finally {
      await g.reader.destroy();
    }
  });

  it('unusable filters: the handler throws (retried, then dead-lettered) and writes nothing', async () => {
    const deps = makeTestDeps({ db });
    for (const filters of [JSON.stringify('{}'), '7', 'null', JSON.stringify({ policy: ['toString'] })]) {
      const n = await makeNotification(db, 'filter', { active: true, filters });
      await expect(fanoutFilter(deps, { notificationId: n.id }, ctx())).rejects.toThrow(/unusable filters/);
      expect(await ids(n.id)).toEqual([]);
    }
  });

  it('an accounts-query error on the reader makes the handler reject', async () => {
    const g = guardedReader({ reject: new Error('replica down') });
    try {
      const deps = makeTestDeps({ db, dbReader: g.wrapped });
      const n = await makeNotification(db, 'filter', { active: true });
      await expect(fanoutFilter(deps, { notificationId: n.id }, ctx())).rejects.toThrow('replica down');
      expect(await ids(n.id)).toEqual([]);
    } finally {
      await g.reader.destroy();
    }
  });

  it('a lost lease (heartbeat throws) propagates and no further range is written', async () => {
    await addFarAccount();
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'filter', { active: true });
    const lost = new Error('lease lost');
    await expect(
      fanoutFilter(
        deps,
        { notificationId: n.id },
        ctx(async () => Promise.reject(lost)),
      ),
    ).rejects.toBe(lost);
    expect(await ids(n.id)).toEqual(ALL);
  });
});
