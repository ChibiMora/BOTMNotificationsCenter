/** Contract: GET /notifications — visibility (B1/B2), order (B3), pagination, query validation, auth. */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const ME = 10;
const OTHER = 11;

describe('GET /notifications', () => {
  const { request, clock } = testApp({ db });
  beforeEach(() => clock.set('2026-10-04T14:30:00Z'));
  const list = (q = '') => request.get(`/notifications${q}`).set('X-Account-Id', String(ME));

  it('B1 matrix: shows live in-window and inactive-but-sent; hides scheduled, out-of-window, removed, others', async () => {
    const n = await makeNotification(db, 'filter', {
      headline: 'Hi',
      subheadline: 'Sub',
    });
    const inactive = await makeNotification(db, 'filter', { active: false });
    const removed = await makeNotification(db, 'filter', { removed: true });
    const live = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: new Date('2026-10-02T08:00:00Z'),
      is_clicked: true,
    });
    const ina = await makeDelivery(db, {
      notification_id: inactive.id,
      account_id: ME,
      sent_at: new Date('2026-10-01T08:00:00Z'),
    });
    await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: null,
    });
    await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: new Date('2026-08-15T00:00:00Z'),
    });
    await makeDelivery(db, {
      notification_id: removed.id,
      account_id: ME,
      sent_at: new Date('2026-10-02T09:00:00Z'),
    });
    await makeDelivery(db, {
      notification_id: n.id,
      account_id: OTHER,
      sent_at: new Date('2026-10-02T09:00:00Z'),
    });
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      items: [
        {
          id: live.public_id,
          headline: 'Hi',
          subheadline: 'Sub',
          isClicked: true,
          liveDate: '2026-10-02T08:00:00Z',
        },
        {
          id: ina.public_id,
          headline: 'H',
          subheadline: 'S',
          isClicked: false,
          liveDate: '2026-10-01T08:00:00Z',
        },
      ],
      nextCursor: null,
    });
    for (const item of r.body.items) {
      expect(Object.keys(item).sort()).toEqual(['headline', 'id', 'isClicked', 'liveDate', 'subheadline']);
    }
  });

  it('B2 window boundaries follow the clock', async () => {
    const n = await makeNotification(db, 'filter');
    const late = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: new Date('2026-08-31T23:59:59Z'),
    });
    const first = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: new Date('2026-09-01T00:00:00Z'),
    });
    clock.set('2026-10-01T00:00:00Z');
    let r = await list();
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([first.public_id]);
    clock.set('2026-09-30T23:59:59Z');
    r = await list();
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([first.public_id, late.public_id]);
    clock.set('2026-11-01T00:00:00Z');
    r = await list();
    expect(r.body).toEqual({ items: [], nextCursor: null });
  });

  it('B3 order: sent_at desc, ties by public_id desc', async () => {
    const n = await makeNotification(db, 'filter');
    const t = new Date('2026-10-02T00:00:00Z');
    const ids = ['dl_aaa', 'dl_ccc', 'dl_bbb'];
    for (const public_id of ids)
      await makeDelivery(db, {
        notification_id: n.id,
        account_id: ME,
        sent_at: t,
        public_id,
      });
    const newest = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: new Date('2026-10-03T00:00:00Z'),
    });
    const r = await list();
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([
      newest.public_id,
      'dl_ccc',
      'dl_bbb',
      'dl_aaa',
    ]);
  });

  it('cursor walks all pages without gaps or repeats; default limit 25; limit=100 clamps to 25', async () => {
    const n = await makeNotification(db, 'filter');
    const expected: string[] = [];
    for (let i = 0; i < 60; i++) {
      // pairs share a sent_at to exercise the tie-break across page edges
      const sent = new Date(Date.UTC(2026, 9, 3, 0, 0, 0) - Math.floor(i / 2) * 60_000);
      const d = await makeDelivery(db, {
        notification_id: n.id,
        account_id: ME,
        sent_at: sent,
      });
      expected.push(d.public_id);
    }
    const all = await list();
    expect(all.body.items).toHaveLength(25);
    const clamped = await list('?limit=100');
    expect(clamped.status).toBe(200);
    expect(clamped.body.items).toHaveLength(25);
    for (const limit of [25, 7, 1]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q: string = `?limit=${limit}` + (cursor ? `&cursor=${cursor}` : '');
        const r = await list(q);
        expect(r.status).toBe(200);
        seen.push(...r.body.items.map((i: { id: string }) => i.id));
        cursor = r.body.nextCursor;
        pages++;
      } while (cursor !== null && pages < 100);
      expect(cursor).toBeNull();
      expect(seen.length).toBe(60);
      expect(new Set(seen).size).toBe(60);
      const order = await db('notification_deliveries')
        .where({ account_id: ME })
        .orderBy([
          { column: 'sent_at', order: 'desc' },
          { column: 'public_id', order: 'desc' },
        ])
        .pluck('public_id');
      expect(seen).toEqual(order);
    }
    expect(new Set(expected).size).toBe(60);
  });

  it('cursor contains no internal ids', async () => {
    const n = await makeNotification(db, 'filter');
    for (let i = 0; i < 3; i++)
      await makeDelivery(db, {
        notification_id: n.id,
        account_id: ME,
        sent_at: new Date('2026-10-02T00:00:00Z'),
      });
    const r = await list('?limit=1');
    const decoded = JSON.parse(Buffer.from(r.body.nextCursor, 'base64url').toString('utf8'));
    expect(Object.keys(decoded).sort()).toEqual(['p', 's']);
    expect(decoded.p).toBe(r.body.items[0].id);
    expect(decoded.s).toBe('2026-10-02T00:00:00Z');
  });

  it('empty list', async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], nextCursor: null });
  });

  const cur = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  it.each([
    ['non-ASCII p', { s: '2026-10-02T00:00:00Z', p: 'dl_bbb\u00e9' }],
    ['non-ASCII 14-char (too short) p', { s: '2026-10-02T00:00:00Z', p: 'dl_bbbbbbbbbb\u00e9' }],
    // Exactly 15 UTF-16 units: only the printable-ASCII character check can reject these.
    ['non-ASCII 15-char p (ends in \u00e9)', { s: '2026-10-02T00:00:00Z', p: 'dl_bbbbbbbbbbb\u00e9' }],
    ['non-ASCII 15-unit p (ends in an emoji)', { s: '2026-10-02T00:00:00Z', p: 'dl_bbbbbbbbbb\u{1F600}' }],
    ['emoji p', { s: '2026-10-02T00:00:00Z', p: '\u{1F600}' }],
    ['too-short p', { s: '2026-10-02T00:00:00Z', p: 'dl_abcdefghijk' }],
    ['too-long p', { s: '2026-10-02T00:00:00Z', p: 'dl_abcdefghijklm' }],
    ['fractional s', { s: '2026-10-02T00:00:00.500Z', p: 'dl_abcdefghijkl' }],
    ['offset s', { s: '2026-10-02T00:00:00+02:00', p: 'dl_abcdefghijkl' }],
    ['non-date s', { s: 'yesterday', p: 'dl_abcdefghijkl' }],
  ])('400 malformed cursor: %s', async (_name, c) => {
    const n = await makeNotification(db, 'filter');
    await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: new Date('2026-10-02T00:00:00Z'),
    });
    const r = await list(`?cursor=${cur(c)}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('VALIDATION_ERROR');
  });

  it("a tampered cursor only ever returns the caller's own deliveries", async () => {
    const n = await makeNotification(db, 'filter');
    const mine = new Set<string>();
    const theirs: { public_id: string; sent_at: Date }[] = [];
    for (let i = 0; i < 4; i++) {
      const sent = new Date(Date.UTC(2026, 9, 2, 0, 0, i * 10));
      mine.add(
        (
          await makeDelivery(db, {
            notification_id: n.id,
            account_id: ME,
            sent_at: sent,
          })
        ).public_id,
      );
      const o = await makeDelivery(db, {
        notification_id: n.id,
        account_id: OTHER,
        sent_at: new Date(sent.getTime() + 5000),
      });
      theirs.push({
        public_id: o.public_id,
        sent_at: new Date(sent.getTime() + 5000),
      });
    }
    const valid = await list('?limit=1');
    expect(valid.body.nextCursor).not.toBeNull();
    const cursors = [
      ...theirs.map((t) => ({
        s: t.sent_at.toISOString().replace('.000Z', 'Z'),
        p: t.public_id,
      })),
      { s: '2026-10-04T14:30:00Z', p: '~~~~~~~~~~~~~~~' },
      { s: '2099-01-01T00:00:00Z', p: 'dl_zzzzzzzzzzzz' },
      { s: '2026-09-01T00:00:00Z', p: '!!!!!!!!!!!!!!!' },
      { s: '2000-01-01T00:00:00Z', p: 'dl_000000000000' },
    ];
    let returned = 0;
    for (const c of cursors) {
      const r = await list(`?cursor=${cur(c)}`);
      expect(r.status).toBe(200);
      for (const item of r.body.items as { id: string }[]) expect(mine.has(item.id), item.id).toBe(true);
      returned += r.body.items.length;
    }
    expect(returned).toBeGreaterThan(0);
  });

  const wrongCursor = Buffer.from(JSON.stringify({ x: 1 })).toString('base64url');
  const badDateCursor = Buffer.from(JSON.stringify({ s: 'nope', p: 'dl_x' })).toString('base64url');
  it.each([
    '?limit=0',
    '?limit=-1',
    '?limit=1.5',
    '?limit=abc',
    '?limit=',
    '?limit=1&limit=2',
    '?cursor=%%%garbage',
    '?cursor=!!',
    `?cursor=${wrongCursor}`,
    `?cursor=${badDateCursor}`,
    '?foo=1',
  ])('400 for %s', async (q) => {
    const r = await list(q);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('VALIDATION_ERROR');
  });

  it('401 without a session', async () => {
    const r = await request.get('/notifications');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'UNAUTHORIZED' });
  });
});
