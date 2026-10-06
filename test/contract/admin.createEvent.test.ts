/** Contract: POST /admin/notifications/event (§3.4, §9.4). */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import type { FakeQueue } from '../helpers/fakeQueue.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const body = {
  image: '/img/a.png',
  headline: 'Shipped!',
  subheadline: 'On its way',
  link: '/box',
  isActive: true,
  eventTrigger: 'shipped',
};
const post = (t: ReturnType<typeof testApp>, b: unknown, key = randomUUID(), acct = '1') =>
  t.request
    .post('/admin/notifications/event')
    .set('X-Account-Id', acct)
    .set('Idempotency-Key', key)
    .send(b as object);

describe('POST /admin/notifications/event', () => {
  it.each(['shipped', 'enrolled', 'preenrollAudiobook'])('201 for %s with delay', async (eventTrigger) => {
    const t = testApp({ db });
    const res = await post(t, { ...body, eventTrigger, delay: 3 });
    expect(res.status).toBe(201);
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
      eventTrigger,
      delay: 3,
      isActive: true,
      activatedAt: res.body.createdAt,
    });
    const row = await db('notifications').where({ id: res.body.id }).first();
    expect(row).toMatchObject({
      type: 2,
      event_trigger: eventTrigger,
      delay: 3,
      filters: null,
      request_endpoint: 'event',
    });
    expect((t.deps.queue as FakeQueue).enqueued).toEqual([]);
  });

  it('delay optional -> null; inactive -> activatedAt null', async () => {
    const res = await post(testApp({ db }), { ...body, isActive: false });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ delay: null, activatedAt: null, isActive: false });
    expect((await db('notifications').first()).delay).toBeNull();
  });

  it('replays the same key and body', async () => {
    const t = testApp({ db });
    const key = randomUUID();
    const a = await post(t, body, key);
    const b = await post(t, body, key);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(await db('notifications').count({ n: '*' })).toEqual([{ n: 1 }]);
    expect((await post(t, { ...body, delay: 1 }, key)).status).toBe(400);
  });

  it.each([
    ['unknown trigger', { ...body, eventTrigger: 'cancelled' }],
    ['missing trigger', { ...body, eventTrigger: undefined }],
    ['missing isActive', { ...body, isActive: undefined }],
    ['delay -1', { ...body, delay: -1 }],
    ['delay 366', { ...body, delay: 366 }],
    ['delay 1.5', { ...body, delay: 1.5 }],
    ['delay string', { ...body, delay: '3' }],
    ['filters key', { ...body, filters: {} }],
  ])('400 %s', async (_n, b) => {
    const res = await post(testApp({ db }), b);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(await db('notifications').count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('400 for delay: null; untrimmed replay of the same request is the same request', async () => {
    const t = testApp({ db });
    expect((await post(t, { ...body, delay: null })).status).toBe(400);
    const key = randomUUID();
    const a = await post(t, { ...body, headline: '  Spaced  ' }, key);
    expect(a.status).toBe(201);
    const b = await post(t, { ...body, headline: 'Spaced' }, key);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it('401 and 403', async () => {
    const t = testApp({ db });
    expect((await t.request.post('/admin/notifications/event').send(body)).status).toBe(401);
    expect((await post(t, body, randomUUID(), '4')).status).toBe(403);
  });
});
