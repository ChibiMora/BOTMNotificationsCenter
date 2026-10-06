/** Contract: PATCH /admin/notifications/:id (§3.4, §7.4, B4–B6). */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pino } from 'pino';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';
import type { FakeQueue } from '../helpers/fakeQueue.js';
import { dueSendTimer } from '../../src/scheduler/dueSend.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

type T = ReturnType<typeof testApp>;
const patch = (t: T, id: number | string, b?: unknown, acct: string | null = '1') => {
  let r = t.request.patch(`/admin/notifications/${id}`);
  if (acct !== null) r = r.set('X-Account-Id', acct);
  return b === undefined ? r : r.send(b as object);
};
const iso = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const sec = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);
const jobs = (t: T) => (t.deps.queue as FakeQueue).enqueued;
const rowOf = (id: number) => db('notifications').where({ id }).first();
const deliveriesOf = (id: number) =>
  db('notification_deliveries').where({ notification_id: id }).orderBy('id');
const HOUR = 3600_000;
const runDueSend = (t: T) => dueSendTimer(t.deps).run(t.deps);

describe('PATCH /admin/notifications/:id — 400 / 404 / 409 and check order', () => {
  const badBodies: Array<[string, unknown]> = [
    ['both keys', { isActive: true, isRemoved: true }],
    ['neither ({})', {}],
    ['extra key', { isActive: true, headline: 'x' }],
    ['isRemoved false', { isRemoved: false }],
    ['isRemoved "true"', { isRemoved: 'true' }],
    ['isActive "true"', { isActive: 'true' }],
    ['isActive null', { isActive: null }],
    ['an array', [{ isActive: true }]],
    ['no body', undefined],
  ];
  for (const [name, b] of badBodies) {
    it(`400 for ${name}`, async () => {
      const t = testApp({ db });
      const n = await makeNotification(db, 'filter', { active: false });
      const before = await rowOf(n.id);
      const res = await patch(t, n.id, b);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(await rowOf(n.id)).toEqual(before);
      expect(jobs(t)).toEqual([]);
    });
  }

  it('400 for a non-integer :id', async () => {
    const t = testApp({ db });
    for (const id of ['abc', '0', '1.5', '-1']) {
      const res = await patch(t, id, { isActive: true });
      expect(res.status).toBe(400);
    }
  });

  it('400 isActive on a csv notification (true and false)', async () => {
    const t = testApp({ db });
    const n = await makeNotification(db, 'csv');
    const before = await rowOf(n.id);
    for (const v of [true, false]) {
      const res = await patch(t, n.id, { isActive: v });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    }
    expect(await rowOf(n.id)).toEqual(before);
    expect(jobs(t)).toEqual([]);
  });

  it('404 unknown id; a bad body on an unknown id is 400 (shape first)', async () => {
    const t = testApp({ db });
    const res = await patch(t, 999999, { isActive: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect((await patch(t, 999999, {})).status).toBe(400);
  });

  it('409 already removed for every valid body; removed csv with isActive is 409 not 400', async () => {
    const t = testApp({ db });
    const n = await makeNotification(db, 'filter', { removed: true, active: false });
    const before = await rowOf(n.id);
    for (const b of [{ isActive: true }, { isActive: false }, { isRemoved: true }]) {
      const res = await patch(t, n.id, b);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('CONFLICT');
    }
    expect(await rowOf(n.id)).toEqual(before);
    const c = await makeNotification(db, 'csv', { removed: true });
    expect((await patch(t, c.id, { isActive: false })).status).toBe(409);
    expect(jobs(t)).toEqual([]);
  });

  it('409 CONFLICT when another connection holds the row lock', async () => {
    const t = testApp({ db });
    const n = await makeNotification(db, 'filter', { active: true, went_live_at: t.clock.now() });
    const trx = await db.transaction();
    try {
      await trx('notifications').where({ id: n.id }).forUpdate().first();
      const res = await patch(t, n.id, { isActive: false });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('CONFLICT');
    } finally {
      await trx.rollback();
    }
    expect(await rowOf(n.id)).toMatchObject({ active: 1, cancelled_before: null });
    expect(jobs(t)).toEqual([]);
  });

  it('401 without a session, 403 for a non-admin', async () => {
    const t = testApp({ db });
    const n = await makeNotification(db, 'filter');
    expect((await patch(t, n.id, { isActive: true }, null)).status).toBe(401);
    expect((await patch(t, n.id, { isActive: true }, '4')).status).toBe(403);
  });
});

describe('PATCH /admin/notifications/:id — applying', () => {
  it('same value is a 200 no-op: nothing written, nothing enqueued (true->true, false->false)', async () => {
    const t = testApp({ db });
    const live = new Date('2026-09-01T00:00:00Z');
    const cb = new Date('2026-09-02T00:00:00Z');
    const a = await makeNotification(db, 'filter', {
      active: true,
      went_live_at: live,
      cancelled_before: cb,
    });
    const b = await makeNotification(db, 'event', {
      active: false,
      went_live_at: live,
      cancelled_before: cb,
    });
    for (const [n, v] of [
      [a, true],
      [b, false],
    ] as const) {
      const before = await rowOf(n.id);
      const res = await patch(t, n.id, { isActive: v });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: n.id, isActive: v, isRemoved: false, activatedAt: iso(live) });
      expect(await rowOf(n.id)).toEqual(before);
    }
    expect(jobs(t)).toEqual([]);
  });

  it('activate a never-activated filter: active, activatedAt = clock, one fanout_filter', async () => {
    const t = testApp({ db });
    const n = await makeNotification(db, 'filter', { active: false });
    const res = await patch(t, n.id, { isActive: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: n.id,
      type: 'filter',
      isActive: true,
      isRemoved: false,
      activatedAt: iso(t.clock.now()),
    });
    const row = await rowOf(n.id);
    expect(row.active).toBeTruthy();
    expect(row.went_live_at).toEqual(sec(t.clock.now()));
    expect(row.cancelled_before).toBeNull();
    expect(jobs(t)).toEqual([
      { type: 'fanout_filter', payload: { notificationId: n.id, requestId: res.headers['x-request-id'] } },
    ]);
  });

  it('activate an event notification enqueues nothing', async () => {
    const t = testApp({ db });
    const n = await makeNotification(db, 'event', { active: false });
    const res = await patch(t, n.id, { isActive: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'event', isActive: true, activatedAt: iso(t.clock.now()) });
    expect(jobs(t)).toEqual([]);
  });

  it('deactivate: inactive, cancelled_before = clock, one cancel_scheduled, delivery rows untouched', async () => {
    const t = testApp({ db });
    const live = new Date('2026-09-01T00:00:00Z');
    const n = await makeNotification(db, 'filter', { active: true, went_live_at: live });
    await makeDelivery(db, {
      notification_id: n.id,
      account_id: 4,
      due_at: new Date(t.clock.now().getTime() + HOUR),
    });
    await makeDelivery(db, {
      notification_id: n.id,
      account_id: 5,
      sent_at: new Date('2026-10-02T00:00:00Z'),
    });
    const before = await deliveriesOf(n.id);
    const res = await patch(t, n.id, { isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: n.id, isActive: false, isRemoved: false, activatedAt: iso(live) });
    const row = await rowOf(n.id);
    expect(row.active).toBeFalsy();
    expect(row.cancelled_before).toEqual(sec(t.clock.now()));
    expect(row.went_live_at).toEqual(live);
    expect(await deliveriesOf(n.id)).toEqual(before);
    expect(jobs(t)).toEqual([
      { type: 'cancel_scheduled', payload: { notificationId: n.id, requestId: res.headers['x-request-id'] } },
    ]);
  });

  it('remove: removed and inactive, one cancel_scheduled, delivery rows untouched', async () => {
    const t = testApp({ db });
    const n = await makeNotification(db, 'filter', { active: true, went_live_at: t.clock.now() });
    await makeDelivery(db, {
      notification_id: n.id,
      account_id: 4,
      due_at: new Date(t.clock.now().getTime() + HOUR),
    });
    const before = await deliveriesOf(n.id);
    const res = await patch(t, n.id, { isRemoved: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: n.id, isActive: false, isRemoved: true });
    const row = await rowOf(n.id);
    expect(row).toMatchObject({ removed: 1, active: 0 });
    expect(row.cancelled_before).toEqual(sec(t.clock.now()));
    expect(await deliveriesOf(n.id)).toEqual(before);
    expect(jobs(t)).toEqual([
      { type: 'cancel_scheduled', payload: { notificationId: n.id, requestId: res.headers['x-request-id'] } },
    ]);
  });

  it('remove works on an inactive notification and on a csv notification', async () => {
    const t = testApp({ db });
    const a = await makeNotification(db, 'event', { active: false });
    const c = await makeNotification(db, 'csv');
    const ra = await patch(t, a.id, { isRemoved: true });
    expect(ra.status).toBe(200);
    expect(ra.body).toMatchObject({ isActive: false, isRemoved: true });
    const rc = await patch(t, c.id, { isRemoved: true });
    expect(rc.status).toBe(200);
    expect(rc.body).toMatchObject({ type: 'csv', isActive: false, isRemoved: true });
    expect((await rowOf(c.id)).removed).toBeTruthy();
    expect(jobs(t).map((j) => j.type)).toEqual(['cancel_scheduled', 'cancel_scheduled']);
  });

  it('a failing enqueue still returns 200 and is logged with ids, never content', async () => {
    let out = '';
    const log = pino({ level: 'debug' }, { write: (chunk: string) => void (out += chunk) });
    const t = testApp({ db, log });
    const n = await makeNotification(db, 'filter', {
      active: true,
      went_live_at: t.clock.now(),
      headline: 'Secret headline',
      subheadline: 'Secret sub',
      link_path: '/secret/link',
    });
    (t.deps.queue as FakeQueue).failNextEnqueue(new Error('down'));
    const res = await patch(t, n.id, { isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    const hit = out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => (e.level as number) >= 40 && e.notificationId === n.id);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.requestId).toBe(res.headers['x-request-id']);
    for (const c of ['Secret headline', 'Secret sub', '/secret/link', '/img/a.png'])
      expect(JSON.stringify(hit[0])).not.toContain(c);
  });

  for (const b of [{ isActive: false }, { isRemoved: true }]) {
    it(`scheduled rows never send after ${JSON.stringify(b)}; live rows untouched`, async () => {
      const t = testApp({ db });
      const now = t.clock.now();
      const n = await makeNotification(db, 'filter', { active: true, went_live_at: now });
      const created = new Date(now.getTime() - HOUR);
      const due = new Date(now.getTime() + HOUR);
      await makeDelivery(db, { notification_id: n.id, account_id: 4, due_at: due }, created);
      await makeDelivery(db, { notification_id: n.id, account_id: 5, due_at: due }, created);
      const liveRow = await makeDelivery(
        db,
        { notification_id: n.id, account_id: 6, sent_at: created },
        created,
      );
      expect((await patch(t, n.id, b)).status).toBe(200);
      t.clock.advance(2 * HOUR);
      await runDueSend(t);
      expect(await deliveriesOf(n.id)).toEqual([liveRow]);
    });
  }

  it('deactivate then reactivate: original activatedAt and cancelled_before kept; old rows never send, new rows do', async () => {
    const t = testApp({ db });
    const live = new Date('2026-09-01T00:00:00Z');
    const n = await makeNotification(db, 'filter', { active: true, went_live_at: live });
    const t0 = t.clock.now();
    const old = await makeDelivery(
      db,
      { notification_id: n.id, account_id: 4, due_at: new Date(t0.getTime() + 3 * HOUR) },
      new Date(t0.getTime() - HOUR),
    );
    expect((await patch(t, n.id, { isActive: false })).status).toBe(200);
    t.clock.advance(HOUR);
    const res = await patch(t, n.id, { isActive: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isActive: true, activatedAt: iso(live) });
    const row = await rowOf(n.id);
    expect(row.went_live_at).toEqual(live);
    expect(row.cancelled_before).toEqual(sec(t0));
    t.clock.advance(HOUR);
    const fresh = await makeDelivery(
      db,
      { notification_id: n.id, account_id: 5, due_at: new Date(t0.getTime() + 3 * HOUR) },
      t.clock.now(),
    );
    t.clock.advance(2 * HOUR);
    await runDueSend(t);
    const after = await deliveriesOf(n.id);
    expect(after.map((d) => d.id)).toEqual([fresh.id]);
    expect(after[0].sent_at).toEqual(sec(t.clock.now()));
    expect(after.find((d) => d.id === old.id)).toBeUndefined();
  });

  it('two concurrent identical PATCHes: one applies, the other is a no-op or 409; one job', async () => {
    const t = testApp({ db });
    const n = await makeNotification(db, 'filter', { active: true, went_live_at: t.clock.now() });
    const [r1, r2] = await Promise.all([
      patch(t, n.id, { isActive: false }),
      patch(t, n.id, { isActive: false }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    expect(jobs(t).filter((j) => j.type === 'cancel_scheduled')).toHaveLength(1);
    const row = await rowOf(n.id);
    expect(row.active).toBeFalsy();
    expect(row.cancelled_before).toEqual(sec(t.clock.now()));
  });
});
