/** Contract: GET /admin/notifications (§3.4). */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import { makeNotification } from '../helpers/factories.js';
import type { NotificationTypeName } from '../../src/lib/rows.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const list = (t: ReturnType<typeof testApp>, q = '', acct = '1') =>
  t.request.get(`/admin/notifications${q}`).set('X-Account-Id', acct);
const day = (d: number) => new Date(Date.UTC(2026, 8, d, 12));
const TYPES: NotificationTypeName[] = ['filter', 'event', 'csv'];

/** 60 rows over 20 days, three per day with identical created_at. */
async function seed() {
  for (let i = 0; i < 60; i++) await makeNotification(db, TYPES[i % 3]!, {}, day(1 + Math.floor(i / 3)));
}

async function walk(t: ReturnType<typeof testApp>, q: string) {
  const ids: number[] = [];
  let cursor: string | null = null;
  do {
    const res = await list(t, `?${q}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.status).toBe(200);
    ids.push(...res.body.items.map((x: { id: number }) => x.id));
    cursor = res.body.nextCursor;
  } while (cursor);
  return ids;
}

describe('GET /admin/notifications', () => {
  it('envelope and item shapes; includes removed, inactive and old', async () => {
    const t = testApp({ db });
    const f = await makeNotification(db, 'filter', { active: false }, new Date('2020-01-01T00:00:00Z'));
    const e = await makeNotification(db, 'event', { went_live_at: day(2) }, day(2));
    const c = await makeNotification(db, 'csv', { removed: true }, day(3));
    const res = await list(t);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          id: c.id,
          headline: 'H',
          subheadline: 'S',
          type: 'csv',
          createdAt: '2026-09-03T12:00:00Z',
          liveDate: '2026-10-01T04:00:00Z',
          isActive: false,
          isRemoved: true,
        },
        {
          id: e.id,
          headline: 'H',
          subheadline: 'S',
          type: 'event',
          createdAt: '2026-09-02T12:00:00Z',
          activatedAt: '2026-09-02T12:00:00Z',
          isActive: true,
          isRemoved: false,
        },
        {
          id: f.id,
          headline: 'H',
          subheadline: 'S',
          type: 'filter',
          createdAt: '2020-01-01T00:00:00Z',
          activatedAt: null,
          isActive: false,
          isRemoved: false,
        },
      ],
      nextCursor: null,
    });
  });

  it('cursor walks all pages newest first without gaps or repeats', async () => {
    await seed();
    const t = testApp({ db });
    const all = (
      await db('notifications').orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
    ).map((r) => r.id);
    expect(await walk(t, 'limit=25')).toEqual(all);
    expect(await walk(t, 'limit=7')).toEqual(all);
    expect(await walk(t, '')).toEqual(all);
    expect((await list(t, '?limit=1000')).body.items).toHaveLength(25);
  });

  it('type and date filters, alone and combined', async () => {
    await seed();
    const t = testApp({ db });
    const ev = await walk(t, 'type=event&limit=5');
    expect(ev).toHaveLength(20);
    const range = await walk(t, 'createdFrom=2026-09-05T12:00:00Z&createdTo=2026-09-07');
    expect(range).toHaveLength(6);
    const both = await walk(
      t,
      'type=csv&createdFrom=2026-09-05T12:00:00Z&createdTo=2026-09-07T12:00:00%2B00:00',
    );
    expect(both).toHaveLength(2);
    expect((await list(t, '?createdFrom=2026-09-10&createdTo=2026-09-01')).body).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('cursor reused under different filters is 400', async () => {
    await seed();
    const t = testApp({ db });
    const cur = (await list(t, '?type=event&limit=2')).body.nextCursor;
    expect((await list(t, `?type=csv&cursor=${cur}`)).status).toBe(400);
    expect((await list(t, `?type=event&createdTo=2026-09-30&cursor=${cur}`)).status).toBe(400);
    expect((await list(t, `?type=event&cursor=${cur}`)).status).toBe(200);
  });

  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  it.each([
    '?limit=0',
    '?limit=-1',
    '?limit=1.5',
    '?limit=abc',
    '?limit=1&limit=2',
    '?cursor=%%%',
    '?cursor=abc',
    `?cursor=${enc({ c: 'x', i: 1 })}`,
    `?cursor=${enc({ c: '2026-09-01T12:00:00.5Z', i: 1 })}`,
    `?cursor=${enc({ c: '2026-09-01T12:00:00Z', i: -1 })}`,
    `?cursor=${enc({ c: '2026-09-01T12:00:00Z', i: 1e300 })}`,
    `?cursor=${enc([1])}`,
    '?type=sms',
    '?type=filter&type=csv',
    '?createdFrom=yesterday',
    '?createdTo=2026-13-01',
    '?foo=1',
    '?headline=%F0%9F%93%9A',
  ])('400 for %s', async (q) => {
    const res = await list(testApp({ db }), q);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rows sharing the cursor exact created_at split across pages: no gaps or repeats; range-seek bound in the SQL', async () => {
    const t = testApp({ db });
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push((await makeNotification(db, 'filter', {}, day(5))).id);
    const older = await makeNotification(db, 'event', {}, day(4));
    const sqls: string[] = [];
    const onQuery = (q: { sql: string }) => sqls.push(q.sql);
    db.on('query', onQuery);
    try {
      expect(await walk(t, 'limit=3')).toEqual([...ids].sort((a, b) => b - a).concat(older.id));
    } finally {
      db.off('query', onQuery);
    }
    const cursorSql = sqls.filter((q) => q.includes('(n.created_at, n.id) < (?, ?)'));
    expect(cursorSql.length).toBeGreaterThan(0);
    for (const q of cursorSql) expect(q).toMatch(/`n`\.`created_at` <= \?/);
  });

  it('401 and 403', async () => {
    const t = testApp({ db });
    expect((await t.request.get('/admin/notifications')).status).toBe(401);
    expect((await list(t, '', '4')).status).toBe(403);
  });
});
