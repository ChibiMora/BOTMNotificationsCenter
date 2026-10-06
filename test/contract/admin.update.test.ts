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
    const before = await rowOf(n.id);
    const r401 = await patch(t, n.id, { isActive: true }, null);
    expect(r401.status).toBe(401);
    expect(r401.body).toEqual({ error: 'UNAUTHORIZED' });
    const r403 = await patch(t, n.id, { isActive: true }, '4');
    expect(r403.status).toBe(403);
    expect(r403.body).toEqual({ error: 'FORBIDDEN' });
    expect(await rowOf(n.id)).toEqual(before);
    expect(jobs(t)).toEqual([]);
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
    expect((await rowOf(a.id)).cancelled_before).toEqual(sec(t.clock.now()));
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

describe('PATCH /admin/notifications/:id — cancelled_before alone decides', () => {
  it('a delivery scheduled before a deactivation is deleted, not sent, after reactivation (notification active)', async () => {
    const t = testApp({ db });
    const t0 = t.clock.now();
    const n = await makeNotification(db, 'filter', { active: true, went_live_at: t0 });
    const due = new Date(t0.getTime() + HOUR);
    const old = await makeDelivery(
      db,
      { notification_id: n.id, account_id: 4, due_at: due },
      new Date(t0.getTime() - HOUR),
    );
    expect((await patch(t, n.id, { isActive: false })).status).toBe(200);
    t.clock.advance(1000);
    expect((await patch(t, n.id, { isActive: true })).status).toBe(200);
    expect(await rowOf(n.id)).toMatchObject({ active: 1, removed: 0 });
    t.clock.advance(1000);
    // Control: created after cancelled_before on the same active notification, so it must be released.
    const fresh = await makeDelivery(
      db,
      { notification_id: n.id, account_id: 5, due_at: due },
      t.clock.now(),
    );
    t.clock.advance(2 * HOUR);
    await runDueSend(t);
    const after = await deliveriesOf(n.id);
    expect(after.find((d) => d.id === old.id)).toBeUndefined();
    expect(after.map((d) => d.id)).toEqual([fresh.id]);
    expect(after[0].sent_at).toEqual(sec(t.clock.now()));
    expect(await rowOf(n.id)).toMatchObject({ active: 1, removed: 0, cancelled_before: sec(t0) });
  });

  it('removing a deactivated notification moves cancelled_before forward to the removal instant', async () => {
    const t = testApp({ db });
    const n = await makeNotification(db, 'filter', { active: true, went_live_at: t.clock.now() });
    const t0 = t.clock.now();
    expect((await patch(t, n.id, { isActive: false })).status).toBe(200);
    expect((await rowOf(n.id)).cancelled_before).toEqual(sec(t0));
    t.clock.advance(11_000);
    expect((await patch(t, n.id, { isRemoved: true })).status).toBe(200);
    const row = await rowOf(n.id);
    expect(row).toMatchObject({ removed: 1, active: 0 });
    expect(row.cancelled_before).toEqual(sec(t.clock.now()));
    expect(row.cancelled_before.getTime()).toBe(sec(t0).getTime() + 11_000);
  });

  it('a second deactivation after a reactivation moves cancelled_before forward and cancels rows created in between', async () => {
    const t = testApp({ db });
    const t0 = t.clock.now();
    const n = await makeNotification(db, 'filter', { active: true, went_live_at: t0 });
    const due = new Date(t0.getTime() + HOUR);
    expect((await patch(t, n.id, { isActive: false })).status).toBe(200);
    t.clock.advance(5000);
    expect((await patch(t, n.id, { isActive: true })).status).toBe(200);
    t.clock.advance(3000);
    const between = await makeDelivery(
      db,
      { notification_id: n.id, account_id: 4, due_at: due },
      t.clock.now(),
    );
    t.clock.advance(3000);
    expect((await patch(t, n.id, { isActive: false })).status).toBe(200);
    const row = await rowOf(n.id);
    expect(row.cancelled_before).toEqual(sec(t.clock.now()));
    expect(row.cancelled_before.getTime()).toBe(sec(t0).getTime() + 11_000);
    t.clock.advance(1000);
    expect((await patch(t, n.id, { isActive: true })).status).toBe(200);
    t.clock.advance(1000);
    const fresh = await makeDelivery(
      db,
      { notification_id: n.id, account_id: 5, due_at: due },
      t.clock.now(),
    );
    t.clock.advance(2 * HOUR);
    await runDueSend(t);
    const after = await deliveriesOf(n.id);
    expect(after.find((d) => d.id === between.id)).toBeUndefined();
    expect(after.map((d) => d.id)).toEqual([fresh.id]);
    expect(after[0].sent_at).toEqual(sec(t.clock.now()));
  });
});

describe('PATCH /admin/notifications/:id — mixed concurrent updates', () => {
  const MIX: unknown[] = [
    { isActive: true },
    { isActive: false },
    { isRemoved: true },
    { isActive: true },
    { isActive: false },
  ];
  for (const type of ['filter', 'event'] as const) {
    it(`${type}: 20 rounds of concurrent activate/deactivate/remove keep the row and jobs consistent`, async () => {
      const t = testApp({ db });
      for (let round = 0; round < 20; round++) {
        const startActive = round % 2 === 0;
        const n = await makeNotification(db, type, {
          active: startActive,
          went_live_at: startActive ? t.clock.now() : null,
          cancelled_before: startActive ? null : new Date('2026-09-01T00:00:00Z'),
        });
        const initial = await rowOf(n.id);
        const bodies = MIX.map((_, i) => MIX[(i + round) % MIX.length]);
        const res = await Promise.all(bodies.map((b) => patch(t, n.id, b)));
        const ok = (pred: (b: Record<string, unknown>) => boolean) =>
          res.filter((r, i) => r.status === 200 && pred(bodies[i] as Record<string, unknown>)).length;
        for (const r of res) expect([200, 409], JSON.stringify(r.body)).toContain(r.status);
        const row = await rowOf(n.id);
        const mine = jobs(t).filter(
          (j) => (j.payload as { notificationId?: number }).notificationId === n.id,
        );
        const cancels = mine.filter((j) => j.type === 'cancel_scheduled').length;
        const fanouts = mine.filter((j) => j.type === 'fanout_filter').length;
        const removes = ok((b) => b.isRemoved === true);
        // Row invariants.
        if (row.removed) expect(row.active).toBeFalsy();
        expect(Boolean(row.removed)).toBe(removes === 1);
        expect(removes).toBeLessThanOrEqual(1);
        if (row.removed || !row.active) expect(row.cancelled_before).not.toBeNull();
        if (row.active) expect(row.went_live_at).not.toBeNull();
        // Job invariants: never more jobs than applied-capable 200s, at least one per observed change.
        expect(cancels).toBeLessThanOrEqual(ok((b) => b.isActive === false) + removes);
        expect(cancels).toBeGreaterThanOrEqual(removes);
        expect(fanouts).toBeLessThanOrEqual(ok((b) => b.isActive === true));
        if (type === 'event') expect(fanouts).toBe(0);
        if (!initial.active && row.active && type === 'filter') expect(fanouts).toBeGreaterThanOrEqual(1);
        if (initial.active && !row.active) expect(cancels).toBeGreaterThanOrEqual(1);
        if (mine.length > 0) expect(row).not.toEqual(initial);
        // A removal that applied is never undone: every later request on this row is a 409.
        if (row.removed) {
          const again = await patch(t, n.id, { isActive: true });
          expect(again.status).toBe(409);
        }
      }
    });
  }
});
