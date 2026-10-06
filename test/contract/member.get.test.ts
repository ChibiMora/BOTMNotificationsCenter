/** Contract: GET /notifications/:id — exact shape, composed URLs, no side effects, B14 identical 404s, auth. */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const ME = 10;
const OTHER = 11;

describe('GET /notifications/:id', () => {
  const { request } = testApp({ db });
  const get = (id: string) => request.get(`/notifications/${id}`).set('X-Account-Id', String(ME));

  it('returns the exact detail shape and does not change is_clicked', async () => {
    const n = await makeNotification(db, 'filter', {
      image_key: '/img/book.png',
      headline: 'New book',
      subheadline: 'Pick now',
      link_path: '/books/42',
    });
    const d = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: new Date('2026-10-02T08:00:05Z'),
    });
    const r = await get(d.public_id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      id: d.public_id,
      image: 'https://assets.example.com/img/book.png',
      headline: 'New book',
      subheadline: 'Pick now',
      link: 'https://www.example.com/books/42',
      liveDate: '2026-10-02T08:00:05Z',
      isClicked: false,
    });
    const row = await db('notification_deliveries').where({ id: d.id }).first();
    expect(Boolean(row.is_clicked)).toBe(false);
  });

  it('inactive-but-sent notification is visible', async () => {
    const n = await makeNotification(db, 'filter', { active: false });
    const d = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: new Date('2026-10-02T08:00:00Z'),
    });
    expect((await get(d.public_id)).status).toBe(200);
  });

  type Fx = {
    others: string;
    scheduled: string;
    rem: string;
    old: string;
    mine: string;
    mineId: number;
  };
  const fixtures = async (): Promise<Fx> => {
    const n = await makeNotification(db, 'filter');
    const removed = await makeNotification(db, 'filter', { removed: true });
    const sent = new Date('2026-10-02T08:00:00Z');
    const others = await makeDelivery(db, {
      notification_id: n.id,
      account_id: OTHER,
      sent_at: sent,
    });
    const scheduled = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: null,
    });
    const rem = await makeDelivery(db, {
      notification_id: removed.id,
      account_id: ME,
      sent_at: sent,
    });
    const old = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: new Date('2026-08-31T23:59:59Z'),
    });
    const mine = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: sent,
    });
    return {
      others: others.public_id,
      scheduled: scheduled.public_id,
      rem: rem.public_id,
      old: old.public_id,
      mine: mine.public_id,
      mineId: mine.id,
    };
  };
  // Replace the last character that is not already `_` (nanoid ids may contain `_`), so the
  // result is never the real id yet would match it under LIKE semantics.
  const wildcard = (id: string, w: string) => {
    let i = id.length - 1;
    while (id[i] === '_') i--;
    return id.slice(0, i) + w + id.slice(i + 1);
  };
  // Reference 404 body: a well-formed (15-char) id that matches no row, so it runs the real lookup.
  const REFERENCE_ID = 'dl_doesNotExist';
  it.each<[string, (f: Fx) => string]>([
    ['well-formed unknown 15-char id', () => REFERENCE_ID],
    ["another account's delivery", (f) => f.others],
    ['scheduled (unsent) delivery', (f) => f.scheduled],
    ['removed notification', (f) => f.rem],
    ['delivery outside the window', (f) => f.old],
    ['too long (16 chars)', () => 'dl_doesNotExist1'],
    ['too short: abc', () => 'abc'],
    ['too short: dl_', () => 'dl_'],
    ['5000 chars', () => 'x'.repeat(5000)],
    ['path traversal', () => encodeURIComponent('../x')],
    ['numeric row id', (f) => String(f.mineId)],
    ['non-ASCII, too short', () => 'dl_aa%C3%A9'],
    ['emoji only, too short', () => '%F0%9F%98%80'],
    ['non-ASCII 15 chars (ends in é)', () => 'dl_aaaaaaaaaaa%C3%A9'],
    ['non-ASCII 15 UTF-16 units (ends in an emoji)', () => 'dl_aaaaaaaaaa%F0%9F%98%80'],
    ['own id + trailing space', (f) => `${f.mine}%20`],
    ['own id truncated to 14', (f) => f.mine.slice(0, 14)],
    ['own id + extra char', (f) => `${f.mine}x`],
    ['own id with a char replaced by _ (LIKE wildcard)', (f) => wildcard(f.mine, '_')],
    ['own id with a char replaced by % (LIKE wildcard)', (f) => wildcard(f.mine, '%25')],
    ['15 chars with a quote and a backslash', () => encodeURIComponent("dl_a'b\\cdefghij")],
  ])('B14: %s yields the reference 404 body', async (_label, idOf) => {
    const f = await fixtures();
    const id = idOf(f);
    if (id !== REFERENCE_ID) expect(decodeURIComponent(id)).not.toBe(f.mine);
    const reference = await get(REFERENCE_ID);
    expect(reference.status).toBe(404);
    expect(JSON.parse(reference.text)).toEqual({ error: 'NOT_FOUND' });
    const r = await get(id);
    expect(r.status, id.slice(0, 40)).toBe(404);
    expect(r.text).toBe(reference.text);
    expect(JSON.parse(r.text)).toEqual(JSON.parse(reference.text));
  });

  it('B14 fixtures: SQL-significant and non-ASCII ids are exactly 15 UTF-16 units', () => {
    for (const id of [REFERENCE_ID, 'dl_aaaaaaaaaaa%C3%A9', 'dl_aaaaaaaaaa%F0%9F%98%80', "dl_a'b\\cdefghij"])
      expect(decodeURIComponent(id).length, id).toBe(15);
  });

  it('401 without a session', async () => {
    const r = await request.get('/notifications/dl_x');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'UNAUTHORIZED' });
  });
});
