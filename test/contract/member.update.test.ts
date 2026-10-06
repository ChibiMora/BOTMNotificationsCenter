/** Contract: PATCH /notifications/:id — set isClicked once, idempotent, body validation, B14 404s, auth. */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const ME = 10;
const OTHER = 11;
const SENT = new Date('2026-10-02T08:00:00Z');

describe('PATCH /notifications/:id', () => {
  const { request } = testApp({ db });
  const patch = (id: string) => request.patch(`/notifications/${id}`).set('X-Account-Id', String(ME));
  const clicked = async (id: number) =>
    Boolean((await db('notification_deliveries').where({ id }).first()).is_clicked);

  it('sets the flag, returns the detail shape, and is idempotent', async () => {
    const n = await makeNotification(db, 'filter', {
      image_key: '/i.png',
      link_path: '/p',
    });
    const d = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: SENT,
    });
    const sibling = await makeDelivery(db, {
      notification_id: n.id,
      account_id: OTHER,
      sent_at: SENT,
    });
    const expected = {
      id: d.public_id,
      image: 'https://assets.example.com/i.png',
      headline: 'H',
      subheadline: 'S',
      link: 'https://www.example.com/p',
      liveDate: '2026-10-02T08:00:00Z',
      isClicked: true,
    };
    const r1 = await patch(d.public_id).send({ isClicked: true });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual(expected);
    expect(await clicked(d.id)).toBe(true);
    const r2 = await patch(d.public_id).send({ isClicked: true });
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(expected);
    expect(await clicked(d.id)).toBe(true);
    expect(await clicked(sibling.id)).toBe(false);
  });

  it.each([
    ['missing', {}],
    ['false', { isClicked: false }],
    ['string', { isClicked: 'true' }],
    ['number', { isClicked: 1 }],
    ['null', { isClicked: null }],
    ['extra key', { isClicked: true, x: 1 }],
    ['array', [true]],
  ])('400 for body %s, nothing changed', async (_name, body) => {
    const n = await makeNotification(db, 'filter');
    const d = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: SENT,
    });
    const r = await patch(d.public_id).send(body as object);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('VALIDATION_ERROR');
    expect(await clicked(d.id)).toBe(false);
  });

  it('400 for an empty body', async () => {
    const n = await makeNotification(db, 'filter');
    const d = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: SENT,
    });
    const r = await patch(d.public_id);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('VALIDATION_ERROR');
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
    const [others, scheduled, rem, old] = [
      await makeDelivery(db, {
        notification_id: n.id,
        account_id: OTHER,
        sent_at: SENT,
      }),
      await makeDelivery(db, {
        notification_id: n.id,
        account_id: ME,
        sent_at: null,
      }),
      await makeDelivery(db, {
        notification_id: removed.id,
        account_id: ME,
        sent_at: SENT,
      }),
      await makeDelivery(db, {
        notification_id: n.id,
        account_id: ME,
        sent_at: new Date('2026-08-01T00:00:00Z'),
      }),
    ];
    const mine = await makeDelivery(db, {
      notification_id: n.id,
      account_id: ME,
      sent_at: SENT,
    });
    return {
      others: others!.public_id,
      scheduled: scheduled!.public_id,
      rem: rem!.public_id,
      old: old!.public_id,
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
    ['5000 chars', () => 'y'.repeat(5000)],
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
  ])('B14: %s yields the reference 404 body and changes no row', async (_label, idOf) => {
    const f = await fixtures();
    const id = idOf(f);
    if (id !== REFERENCE_ID) expect(decodeURIComponent(id)).not.toBe(f.mine);
    const reference = await patch(REFERENCE_ID).send({ isClicked: true });
    expect(reference.status).toBe(404);
    expect(JSON.parse(reference.text)).toEqual({ error: 'NOT_FOUND' });
    const r = await patch(id).send({ isClicked: true });
    expect(r.status, id.slice(0, 40)).toBe(404);
    expect(r.text).toBe(reference.text);
    expect(JSON.parse(r.text)).toEqual(JSON.parse(reference.text));
    const changed = await db('notification_deliveries').where({ is_clicked: true }).count({ c: '*' });
    expect(Number(changed[0]!.c)).toBe(0);
  });

  it('B14 fixtures: SQL-significant and non-ASCII ids are exactly 15 UTF-16 units', () => {
    for (const id of [REFERENCE_ID, 'dl_aaaaaaaaaaa%C3%A9', 'dl_aaaaaaaaaa%F0%9F%98%80', "dl_a'b\\cdefghij"])
      expect(decodeURIComponent(id).length, id).toBe(15);
  });

  it('401 without a session', async () => {
    const r = await request.patch('/notifications/dl_x').send({ isClicked: true });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'UNAUTHORIZED' });
  });
});
