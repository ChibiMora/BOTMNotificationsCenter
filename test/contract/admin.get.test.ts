/** Contract: GET /admin/notifications/:id (§3.3, §3.4). */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import { makeNotification } from '../helpers/factories.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const at = new Date('2026-09-01T12:00:00Z');
const get = (t: ReturnType<typeof testApp>, id: string | number, acct = '1') =>
  t.request.get(`/admin/notifications/${id}`).set('X-Account-Id', acct);

describe('GET /admin/notifications/:id', () => {
  it('filter detail with filters echo, URLs composed', async () => {
    const t = testApp({ db });
    const filters = { country: ['CA'], relationshipStatus: ['friend', 'bff'], credits: { minimum: 1 } };
    const n = await makeNotification(
      db,
      'filter',
      { filters: JSON.stringify(filters), went_live_at: at },
      at,
    );
    const res = await get(t, n.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: n.id,
      type: 'filter',
      image: t.deps.config.assetBaseUrl.replace(/\/+$/, '') + '/img/a.png',
      headline: 'H',
      subheadline: 'S',
      link: t.deps.config.siteBaseUrl.replace(/\/+$/, '') + '/x',
      isActive: true,
      isRemoved: false,
      createdAt: '2026-09-01T12:00:00Z',
      activatedAt: '2026-09-01T12:00:00Z',
      filters,
    });
  });

  it('event detail; activatedAt null when never activated', async () => {
    const n = await makeNotification(
      db,
      'event',
      { event_trigger: 'enrolled', delay: null, active: false },
      at,
    );
    const res = await get(testApp({ db }), n.id);
    expect(Object.keys(res.body).sort()).toEqual([
      'activatedAt',
      'createdAt',
      'delay',
      'eventTrigger',
      'headline',
      'id',
      'image',
      'isActive',
      'isRemoved',
      'link',
      'subheadline',
      'type',
    ]);
    expect(res.body).toMatchObject({
      type: 'event',
      eventTrigger: 'enrolled',
      delay: null,
      activatedAt: null,
      isActive: false,
    });
  });

  it('csv detail has liveDate only; isActive true until removed', async () => {
    const n = await makeNotification(db, 'csv', { removed: true }, at);
    const res = await get(testApp({ db }), n.id);
    expect(Object.keys(res.body).sort()).toEqual([
      'createdAt',
      'headline',
      'id',
      'image',
      'isActive',
      'isRemoved',
      'link',
      'liveDate',
      'subheadline',
      'type',
    ]);
    expect(res.body).toMatchObject({ liveDate: '2026-10-01T04:00:00Z', isRemoved: true, isActive: false });
    const live = await makeNotification(db, 'csv', { active: false }, at);
    expect((await get(testApp({ db }), live.id)).body.isActive).toBe(true);
  });

  it.each(['abc', '0', '-1', '1.5', '99999999999999999999'])('400 for id %s', async (id) => {
    const res = await get(testApp({ db }), id);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('404, 401, 403', async () => {
    const t = testApp({ db });
    expect((await get(t, 999)).body).toEqual({ error: 'NOT_FOUND', message: expect.any(String) });
    expect((await t.request.get('/admin/notifications/1')).status).toBe(401);
    expect((await get(t, 1, '4')).status).toBe(403);
  });
});
