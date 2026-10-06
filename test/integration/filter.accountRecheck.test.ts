// account_recheck (§7.2 "When an account changes", §8.2 row; B8) against the real database and seeded accounts.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, updateAccount } from '../helpers/db.js';
import type { Knex } from 'knex';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { makeNotification } from '../helpers/factories.js';
import { FixedClock } from '../helpers/clock.js';
import { accountRecheck, recheckAccount } from '../../src/jobs/accountRecheck.js';
import { fanoutFilter } from '../../src/jobs/fanoutFilter.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
const ctx = { attempt: 1, heartbeat: async () => {} };
const forAccount = (id: number) =>
  db('notification_deliveries').where({ account_id: id }).orderBy('notification_id');
const json = (f: object) => JSON.stringify(f);

describe('account_recheck', () => {
  it('one call uses one instant and one month key, even when the clock crosses into the next month mid-call', async () => {
    // Advances into November on its second reading.
    class CrossingClock extends FixedClock {
      readings = 0;
      override now() {
        if (++this.readings === 2) this.set('2026-11-01T00:00:00Z');
        return super.now();
      }
    }
    const clock = new CrossingClock(new Date('2026-10-31T23:59:59Z'));
    const deps = makeTestDeps({ db, clock });
    // Account 1 = US/monthly/new_member/0; three notifications that all match it.
    for (const filters of [{}, { country: ['US'] }, { policy: ['monthly'] }]) {
      await makeNotification(db, 'filter', { active: true, filters: json(filters) });
    }
    expect(await recheckAccount(deps, 1)).toBe(3);
    const got = await forAccount(1);
    expect(got).toHaveLength(3);
    for (const r of got) {
      expect(r.dedupe_key).toBe('2026-10');
      expect(new Date(r.sent_at).toISOString()).toBe('2026-10-31T23:59:59.000Z');
      expect(new Date(r.due_at).toISOString()).toBe('2026-10-31T23:59:59.000Z');
    }
  });

  it('a newly eligible account gets the delivery when the job runs, with no rescan; again adds nothing', async () => {
    const deps = makeTestDeps({ db });
    // Account 1 = US/monthly/new_member/0; the filter wants at least 5 credits.
    const n = await makeNotification(db, 'filter', {
      active: true,
      filters: json({ credits: { minimum: 5 } }),
    });
    await fanoutFilter(deps, { notificationId: n.id }, ctx);
    expect(await forAccount(1)).toEqual([]);
    await updateAccount(db, 1, { credits: 5 });
    await accountRecheck(deps, { accountId: 1 }, ctx);
    const got = await forAccount(1);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ notification_id: n.id, dedupe_key: '2026-10' });
    expect(new Date(got[0].sent_at).getTime()).toBe(deps.clock.now().getTime());
    await accountRecheck(deps, { accountId: 1 }, ctx);
    expect(await forAccount(1)).toHaveLength(1);
  });

  it('considers every active filter notification, skipping non-matching, inactive, removed and non-filter ones', async () => {
    const deps = makeTestDeps({ db });
    // Account 44 = CA/monthly/friend/1.
    const a = await makeNotification(db, 'filter', { active: true, filters: json({ country: ['CA'] }) });
    const b = await makeNotification(db, 'filter', {
      active: true,
      filters: json({ relationshipStatus: ['friend'] }),
    });
    await makeNotification(db, 'filter', { active: true, filters: json({ country: ['US'] }) });
    await makeNotification(db, 'filter', { active: false });
    await makeNotification(db, 'filter', { active: true, removed: true });
    await makeNotification(db, 'event', { active: true });
    await recheckAccount(deps, 44);
    expect((await forAccount(44)).map((r) => r.notification_id)).toEqual([a.id, b.id]);
    expect(await db('notification_deliveries').count({ n: '*' }).first()).toEqual({ n: 2 });
  });

  it('unknown account: done, no error', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'filter', { active: true });
    await expect(accountRecheck(deps, { accountId: 999_999 }, ctx)).resolves.toBeUndefined();
    expect(await db('notification_deliveries').count({ n: '*' }).first()).toEqual({ n: 0 });
  });
});

/** A reader handle that fails on any use: recheckAccount must never touch the replica. */
const poisonedReader = () => {
  const touched: string[] = [];
  const fail = (what: string) => {
    touched.push(what);
    throw new Error(`dbReader used: ${what}`);
  };
  const reader = new Proxy(function () {}, {
    apply: () => fail('call'),
    get: (_t, p) => fail(String(p)),
  }) as unknown as Knex;
  return { reader, touched };
};

describe('account_recheck reads the writer, never the lagging replica', () => {
  it('newly eligible account (replica still stale) gets its delivery; reader untouched', async () => {
    const { reader, touched } = poisonedReader();
    const deps = makeTestDeps({ db, dbReader: reader });
    const n = await makeNotification(db, 'filter', {
      active: true,
      filters: json({ credits: { minimum: 5 } }),
    });
    await updateAccount(db, 1, { credits: 5 });
    await accountRecheck(deps, { accountId: 1 }, ctx);
    expect((await forAccount(1)).map((r) => r.notification_id)).toEqual([n.id]);
    expect(touched).toEqual([]);
  });
  it('an account changed out of eligibility gets none; reader untouched', async () => {
    const { reader, touched } = poisonedReader();
    const deps = makeTestDeps({ db, dbReader: reader });
    // Account 5 = US/monthly/new_member/5; the filter wants at least 5 credits.
    await makeNotification(db, 'filter', { active: true, filters: json({ credits: { minimum: 5 } }) });
    await updateAccount(db, 5, { credits: 0 });
    await recheckAccount(deps, 5);
    expect(await forAccount(5)).toEqual([]);
    expect(touched).toEqual([]);
  });
  it('one notification with unusable filters does not stop the others: logged by id, counted, skipped', async () => {
    const deps = makeTestDeps({ db });
    const bad1 = await makeNotification(db, 'filter', {
      active: true,
      filters: json({ relationshipStatus: ['toString'] }),
    });
    const bad2 = await makeNotification(db, 'filter', {
      active: true,
      filters: JSON.stringify('{"country":["US"]}'),
    });
    const good = await makeNotification(db, 'filter', { active: true, filters: json({ country: ['US'] }) });
    await expect(accountRecheck(deps, { accountId: 1 }, ctx)).resolves.toBeUndefined();
    expect((await forAccount(1)).map((r) => r.notification_id)).toEqual([good.id]);
    expect((deps.metrics as RecordingMetrics).calls).toContainEqual(
      expect.objectContaining({ name: 'account_recheck.unusable_filters', value: 1 }),
    );
    expect(
      (deps.metrics as RecordingMetrics).calls.filter((c) => c.name === 'account_recheck.unusable_filters'),
    ).toHaveLength(2);
    expect(await db('notification_deliveries').whereIn('notification_id', [bad1.id, bad2.id])).toEqual([]);
  });
});
