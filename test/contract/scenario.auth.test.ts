// §10.3 scenario test: authorization across every /admin route, and the uniform member 404.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDb, testDb } from '../helpers/db.js';
import { scenario, content } from '../helpers/scenario.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

describe('scenario: authorization', () => {
  it('403s a member on every /admin route and gives one 404 body for every id they may not see', async () => {
    const s = await scenario(db);
    const filter = await s.admin.filter({ ...content('Mine'), isActive: true, filters: { country: ['US'] } });
    const event = await s.admin.event({
      ...content('Later'),
      isActive: true,
      eventTrigger: 'shipped',
      delay: 5,
    });
    await s.trigger.record({ type: 'shipped', accountId: 8, occurredAt: s.clock.now(), occurrenceKey: 'k' });
    await s.runWorker();
    const nid = filter.body.id as string;

    // 1. Account 9 (a plain member) gets 403 on every /admin route.
    const m = '9';
    const key = () => randomUUID();
    const routes = [
      () => s.request.get('/admin/notifications').set('X-Account-Id', m),
      () => s.request.get(`/admin/notifications/${nid}`).set('X-Account-Id', m),
      () =>
        s.request
          .post('/admin/notifications/filter')
          .set('X-Account-Id', m)
          .set('Idempotency-Key', key())
          .send({}),
      () =>
        s.request
          .post('/admin/notifications/event')
          .set('X-Account-Id', m)
          .set('Idempotency-Key', key())
          .send({}),
      () =>
        s.request
          .post('/admin/notifications/imports')
          .set('X-Account-Id', m)
          .set('Idempotency-Key', key())
          .field('x', 'y'),
      () => s.request.get('/admin/notifications/imports/1').set('X-Account-Id', m),
      () =>
        s.request
          .post('/admin/notifications/imports/1/runs')
          .set('X-Account-Id', m)
          .set('Idempotency-Key', key())
          .send({}),
      () => s.request.patch(`/admin/notifications/${nid}`).set('X-Account-Id', m).send({ isActive: false }),
    ];
    for (const r of routes) expect((await r()).status).toBe(403);

    // 2. Ids member 8 may not see: another member's delivery, its own unsent (scheduled) one, a removed one, nonsense.
    const others = (await s.member(9))[0]!.id;
    // Read from the database: no API exposes an unsent delivery's id.
    const pub = async (headline: string, acct: number) =>
      (
        await db('notification_deliveries as d')
          .join('notifications as n', 'n.id', 'd.notification_id')
          .where({ 'n.headline': headline, 'd.account_id': acct })
          .first('d.public_id')
      ).public_id as string;
    const scheduled = await pub('Later', 8);
    const removed = (await s.member(8)).find((i) => i.headline === 'Mine')!.id;
    expect((await s.admin.patch(nid, { isRemoved: true })).status).toBe(200);
    await s.runWorker(); // the remove enqueues cancel_scheduled
    expect(event.status).toBe(201);

    const bodies: unknown[] = [];
    for (const id of [others, scheduled, removed, 'not-a-real-id']) {
      const g = await s.request.get(`/notifications/${id}`).set('X-Account-Id', '8');
      const p = await s.request
        .patch(`/notifications/${id}`)
        .set('X-Account-Id', '8')
        .send({ isClicked: true });
      expect([g.status, p.status]).toEqual([404, 404]);
      bodies.push(g.body, p.body);
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    await s.expectQueueIdle();
  });
});
