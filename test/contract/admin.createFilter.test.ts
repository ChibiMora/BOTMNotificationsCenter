/** Contract: POST /admin/notifications/filter (§3.4, §9.4). */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import type { FakeQueue } from '../helpers/fakeQueue.js';
import { pino } from 'pino';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const body = {
  image: '/img/a.png',
  headline: '  Fall picks ',
  subheadline: 'New & noted',
  link: '/books/fall',
  isActive: true,
};
const post = (t: ReturnType<typeof testApp>, b: unknown, key: string | null = randomUUID(), acct = '1') => {
  const r = t.request.post('/admin/notifications/filter').set('X-Account-Id', acct);
  return key === null ? r.send(b as object) : r.set('Idempotency-Key', key).send(b as object);
};

describe('POST /admin/notifications/filter', () => {
  it('201 active: detail, stored row, one fanout job', async () => {
    const t = testApp({ db });
    const res = await post(t, {
      ...body,
      filters: { country: ['CA', 'CA'], policy: [], credits: { minimum: 1 } },
    });
    expect(res.status).toBe(201);
    const now = t.clock.now();
    const iso = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    expect(res.body).toEqual({
      id: expect.any(Number),
      type: 'filter',
      image: t.deps.config.assetBaseUrl.replace(/\/+$/, '') + '/img/a.png',
      headline: 'Fall picks',
      subheadline: 'New & noted',
      link: t.deps.config.siteBaseUrl.replace(/\/+$/, '') + '/books/fall',
      isActive: true,
      isRemoved: false,
      createdAt: iso,
      activatedAt: iso,
      filters: { country: ['CA'], credits: { minimum: 1 } },
    });
    const row = await db('notifications').where({ id: res.body.id }).first();
    expect(row).toMatchObject({
      type: 1,
      image_key: '/img/a.png',
      link_path: '/books/fall',
      request_endpoint: 'filter',
    });
    expect(row.filters).toEqual({ country: ['CA'], credits: { minimum: 1 } });
    expect(row.request_hash).toMatch(/^[0-9a-f]{64}$/);
    const q = t.deps.queue as FakeQueue;
    expect(q.enqueued).toEqual([
      { type: 'fanout_filter', payload: { notificationId: res.body.id, requestId: expect.any(String) } },
    ]);
  });

  it('201 inactive: activatedAt null, filters {} when omitted, no job', async () => {
    const t = testApp({ db });
    const res = await post(t, { ...body, isActive: false });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ isActive: false, activatedAt: null, filters: {} });
    const row = await db('notifications').where({ id: res.body.id }).first();
    expect(row.filters).toEqual({});
    expect(row.went_live_at).toBeNull();
    expect((t.deps.queue as FakeQueue).enqueued).toEqual([]);
  });

  it('a failing enqueue still returns 201', async () => {
    const t = testApp({ db });
    (t.deps.queue as FakeQueue).failNextEnqueue(new Error('down'));
    const res = await post(t, body);
    expect(res.status).toBe(201);
    expect(await db('notifications').count({ n: '*' })).toEqual([{ n: 1 }]);
  });

  it('replay with same key and same (reordered) body returns current representation, no new row or job', async () => {
    const t = testApp({ db });
    const key = randomUUID();
    const first = await post(t, body, key);
    await db('notifications').where({ id: first.body.id }).update({ headline: 'Edited' });
    const { isActive, ...rest } = body;
    const again = await post(t, { isActive, ...rest }, key.toUpperCase());
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ ...first.body, headline: 'Edited' });
    expect(await db('notifications').count({ n: '*' })).toEqual([{ n: 1 }]);
    expect((t.deps.queue as FakeQueue).enqueued).toHaveLength(1);
  });

  it('400 when the key was used for a different body or the other endpoint', async () => {
    const t = testApp({ db });
    const key = randomUUID();
    await post(t, body, key);
    const diff = await post(t, { ...body, headline: 'Other' }, key);
    expect(diff.status).toBe(400);
    expect(diff.body).toEqual({
      error: 'VALIDATION_ERROR',
      message: 'Idempotency-Key already used for a different request',
    });
    const other = await t.request
      .post('/admin/notifications/event')
      .set('X-Account-Id', '1')
      .set('Idempotency-Key', key)
      .send({ ...body, eventTrigger: 'shipped' });
    expect(other.status).toBe(400);
    expect(await db('notifications').count({ n: '*' })).toEqual([{ n: 1 }]);
  });

  const bad: Array<[string, unknown]> = [
    ['missing isActive', { ...body, isActive: undefined }],
    ['isActive string', { ...body, isActive: 'true' }],
    ['missing image', { ...body, image: undefined }],
    ['missing headline', { ...body, headline: undefined }],
    ['missing subheadline', { ...body, subheadline: undefined }],
    ['missing link', { ...body, link: undefined }],
    ['bad country', { ...body, filters: { country: ['MX'] } }],
    ['bad policy', { ...body, filters: { policy: ['weekly'] } }],
    ['bad relationship', { ...body, filters: { relationshipStatus: ['x'] } }],
    ['min > max', { ...body, filters: { credits: { minimum: 5, maximum: 1 } } }],
    ['negative credits', { ...body, filters: { credits: { minimum: -1 } } }],
    ['non-integer credits', { ...body, filters: { credits: { maximum: 1.5 } } }],
    ['huge credits', { ...body, filters: { credits: { maximum: 1e400 } } }],
    ['unknown top key', { ...body, extra: 1 }],
    ['unknown filters key', { ...body, filters: { foo: [] } }],
    ['unknown credits key', { ...body, filters: { credits: { min: 1 } } }],
    ['filters array', { ...body, filters: [] }],
    ['full URL', { ...body, link: 'https://evil.com/x' }],
    ['//host', { ...body, image: '//evil.com/x.png' }],
    ['backslash', { ...body, link: '/a\\b' }],
    ['query', { ...body, link: '/a?b=1' }],
    ['fragment', { ...body, link: '/a#b' }],
    ['dot-dot', { ...body, link: '/a/../b' }],
    ['script', { ...body, headline: '<script>x</script>' }],
    ['lone <', { ...body, subheadline: 'a < b' }],
    ['line break', { ...body, headline: 'a\nb' }],
    ['direction override', { ...body, headline: 'a‮b' }],
    ['whitespace only', { ...body, headline: '   ' }],
    ['256 chars', { ...body, headline: 'x'.repeat(256) }],
    ['headline object', { ...body, headline: { a: 1 } }],
    ['null body', null],
    ['array body', [body]],
  ];
  it.each(bad)('400 %s, nothing stored', async (_n, b) => {
    const t = testApp({ db });
    const res = await post(t, b);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(await db('notifications').count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('accepts emoji and non-Latin text', async () => {
    const res = await post(testApp({ db }), {
      ...body,
      headline: '新しい本 📚',
      subheadline: 'Ça va — “oui”',
    });
    expect(res.status).toBe(201);
    expect(res.body.headline).toBe('新しい本 📚');
  });

  it.each([[null], ['not-a-uuid']])('400 Idempotency-Key %s', async (key) => {
    const t = testApp({ db });
    const res = await post(t, body, key);
    expect(res.status).toBe(400);
    expect(await db('notifications').count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('a failing enqueue is logged at error/warn with notification id and request id, no content', async () => {
    let out = '';
    const log = pino({ level: 'debug' }, { write: (chunk: string) => void (out += chunk) });
    const t = testApp({ db, log });
    (t.deps.queue as FakeQueue).failNextEnqueue(new Error('down'));
    const res = await post(t, body);
    expect(res.status).toBe(201);
    const entries = out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const hit = entries.filter((e) => (e.level as number) >= 40 && e.notificationId === res.body.id);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.requestId).toBe(res.headers['x-request-id']);
    const line = JSON.stringify(hit[0]);
    for (const c of ['Fall picks', 'New & noted', '/books/fall', '/img/a.png']) expect(line).not.toContain(c);
  });

  it('replays with equivalent shapes (filters absent / {} / empty arrays, untrimmed, dupes, reordered) -> same id, one row', async () => {
    const t = testApp({ db });
    const key = randomUUID();
    const shapes: unknown[] = [
      { ...body, isActive: false },
      { ...body, isActive: false, filters: {} },
      { ...body, isActive: false, filters: { country: [] } },
      { ...body, isActive: false, filters: { country: [], policy: [], relationshipStatus: [] } },
      { ...body, isActive: false, headline: 'Fall picks', filters: {} },
    ];
    const first = await post(t, shapes[0], key);
    expect(first.status).toBe(201);
    for (const b of shapes.slice(1)) {
      const r = await post(t, b, key);
      expect(r.status).toBe(201);
      expect(r.body.id).toBe(first.body.id);
    }
    const k2 = randomUUID();
    const a = await post(t, { ...body, filters: { country: ['US', 'CA'], policy: ['annual'] } }, k2);
    const b2 = await post(
      t,
      { filters: { policy: ['annual', 'annual'], country: ['CA', 'US', 'US'] }, ...body },
      k2,
    );
    expect(b2.status).toBe(201);
    expect(b2.body.id).toBe(a.body.id);
    expect(await db('notifications').count({ n: '*' })).toEqual([{ n: 2 }]);
    const diff = await post(t, { ...body, isActive: false, filters: { country: ['US'] } }, key);
    expect(diff.status).toBe(400);
  });

  it('explicit filters {} and all-empty arrays store {} and return {}', async () => {
    const t = testApp({ db });
    for (const filters of [{}, { country: [], policy: [], relationshipStatus: [] }]) {
      const res = await post(t, { ...body, filters });
      expect(res.status).toBe(201);
      expect(res.body.filters).toEqual({});
      const row = await db('notifications').where({ id: res.body.id }).first();
      expect(row.filters).toEqual({});
    }
  });

  it('400 for a lone surrogate and for credits above the INT range', async () => {
    const t = testApp({ db });
    for (const b of [
      { ...body, headline: '\ud800x' },
      { ...body, link: '/books/\ud800x' },
      { ...body, filters: { credits: { maximum: 2147483648 } } },
      { ...body, filters: { credits: { minimum: 1e300 } } },
    ]) {
      expect((await post(t, b)).status).toBe(400);
    }
    expect(await db('notifications').count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('headline of 255 astral characters is returned identically; 256 is 400', async () => {
    const t = testApp({ db });
    const h = '📚'.repeat(255);
    const ok = await post(t, { ...body, headline: h });
    expect(ok.status).toBe(201);
    expect(ok.body.headline).toBe(h);
    expect((await db('notifications').where({ id: ok.body.id }).first()).headline).toBe(h);
    expect((await post(t, { ...body, headline: h + '📚' })).status).toBe(400);
  });

  it('401 and 403', async () => {
    const t = testApp({ db });
    expect((await t.request.post('/admin/notifications/filter').send(body)).status).toBe(401);
    expect((await post(t, body, randomUUID(), '4')).status).toBe(403);
  });
});
