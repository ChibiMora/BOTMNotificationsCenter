// §10.3 scenario tests named after docs/spec.md sentences: behaviours proved end to end through the API, worker and
// timers, asserting on what the member endpoints return.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db.js';
import { scenario, content, DAY, SEEDED_IDS } from '../helpers/scenario.js';
import { dueSendTimer } from '../../src/scheduler/dueSend.js';
import { rescanTimer } from '../../src/scheduler/rescan.js';
import { expiryTimer } from '../../src/scheduler/expiry.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

type S = Awaited<ReturnType<typeof scenario>>;
const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');
const MIN = 60_000;
const UNKNOWN_ID = 'zzzzzzzzzzzzzzz'; // 15 characters, the public_id shape, never issued

// Seed layout (scripts/seedAccounts.ts): id = 1 + index over country × policy × status × credits (0,1,2,3,5,10),
// credits varying fastest; so an account's credits are CREDITS[(id - 1) % 6].
const CREDITS = [0, 1, 2, 3, 5, 10];
const creditsOf = (id: number) => CREDITS[(id - 1) % 6]!;

const getOne = (s: S, account: number, id: string) =>
  s.request.get(`/notifications/${id}`).set('X-Account-Id', String(account));
const click = (s: S, account: number, id: string) =>
  s.request.patch(`/notifications/${id}`).set('X-Account-Id', String(account)).send({ isClicked: true });
const dueSend = async (s: S) => {
  await dueSendTimer(s.deps).run(s.deps);
  await s.runWorker();
};
const rescan = async (s: S) => {
  await rescanTimer(s.deps).run(s.deps);
  await s.runWorker();
};
type EventType = Parameters<S['trigger']['record']>[0]['type'];
const record = (
  s: S,
  type: EventType,
  accountId: number,
  occurrenceKey: string,
  occurredAt = s.clock.now(),
) => s.trigger.record({ type, accountId, occurredAt, occurrenceKey });
const mine = async (s: S, account: number, headline: string) =>
  (await s.member(account)).filter((i) => i.headline === headline);

describe('spec: "If 2 friends join with my RAF link, I will get 2 notifications"', () => {
  it('two enrolled occurrences give the referrer two items; replaying one adds nothing', async () => {
    const s = await scenario(db);
    expect(
      (await s.admin.event({ ...content('Friend joined'), isActive: true, eventTrigger: 'enrolled' })).status,
    ).toBe(201);
    await record(s, 'enrolled', 12, 'raf:friend-a');
    await record(s, 'enrolled', 12, 'raf:friend-b');
    await s.runWorker();
    expect(await mine(s, 12, 'Friend joined')).toHaveLength(2);

    await record(s, 'enrolled', 12, 'raf:friend-a');
    await s.runWorker();
    expect(await mine(s, 12, 'Friend joined')).toHaveLength(2);
    expect(await s.seenBy('Friend joined')).toEqual([12]);
    await s.expectQueueIdle();
  });
});

describe('spec: "An enroll-triggered notification with a delay of 5 should appear 5 days after enroll"', () => {
  it('counts the 5 days from the event, not from the notification creation', async () => {
    const s = await scenario(db);
    const createdAt = s.clock.now();
    const t0 = new Date(createdAt.getTime() - 2 * 60 * MIN); // the enroll happened 2 hours before creation
    expect(
      (await s.admin.event({ ...content('Welcome +5'), isActive: true, eventTrigger: 'enrolled', delay: 5 }))
        .status,
    ).toBe(201);
    await record(s, 'enrolled', 13, 'enroll:13', t0);
    await s.runWorker();
    expect(await s.member(13)).toEqual([]);

    s.clock.set(iso(new Date(t0.getTime() + 5 * DAY - MIN)));
    await dueSend(s);
    expect(await s.member(13)).toEqual([]);

    s.clock.set(iso(new Date(t0.getTime() + 5 * DAY)));
    await dueSend(s);
    const items = await mine(s, 13, 'Welcome +5');
    expect(items).toHaveLength(1);
    const live = Date.parse(items[0]!.liveDate);
    expect(live).toBeGreaterThanOrEqual(t0.getTime() + 5 * DAY);
    expect(live).toBeLessThan(createdAt.getTime() + 5 * DAY);
    await s.expectQueueIdle();
  });
});

describe('spec: "on 8/2 there is not another notification triggered for the same eligible people"', () => {
  it('a filter sent on day 1 is not re-sent on day 2 or day 20, only on the first of next month', async () => {
    const s = await scenario(db);
    s.clock.set('2026-11-01T09:00:00Z');
    const f = { country: ['US'], policy: ['annual'], credits: { minimum: 1 } };
    expect((await s.admin.filter({ ...content('New books'), isActive: true, filters: f })).status).toBe(201);
    await s.runWorker();
    expect(await mine(s, 20, 'New books')).toHaveLength(1);

    s.clock.set('2026-11-02T09:00:00Z');
    await rescan(s);
    s.clock.set('2026-11-20T09:00:00Z');
    await rescan(s);
    expect(await mine(s, 20, 'New books')).toHaveLength(1);

    s.clock.set('2026-12-01T00:10:00Z');
    await rescan(s);
    expect(await mine(s, 20, 'New books')).toHaveLength(2);
    await s.expectQueueIdle();
  });
});

describe('spec: "If no X selected, all X are eligible" (each list filter on its own)', () => {
  it('an empty country, policy or relationshipStatus list selects exactly what the credits bound alone selects', async () => {
    const s = await scenario(db);
    const credits = { minimum: 5 };
    const expected = SEEDED_IDS.filter((id) => creditsOf(id) >= 5);
    expect(expected).toHaveLength(24);
    for (const [headline, filters] of [
      ['Empty country', { country: [], credits }],
      ['Empty policy', { policy: [], credits }],
      ['Empty status', { relationshipStatus: [], credits }],
    ] as const) {
      const r = await s.admin.filter({ ...content(headline), isActive: true, filters });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    await s.runWorker();
    expect(await s.seenBy('Empty country')).toEqual(expected);
    expect(await s.seenBy('Empty policy')).toEqual(expected);
    expect(await s.seenBy('Empty status')).toEqual(expected);
    await s.expectQueueIdle();
  });
});

describe('spec: "Account must have a number of credits that falls within the inputted credit range"', () => {
  it('min 3 and max 5 are both inclusive: 3 and 5 are sent, 2 and 10 are not', async () => {
    const s = await scenario(db);
    const filters = { country: ['US'], policy: ['annual'], credits: { minimum: 3, maximum: 5 } };
    expect((await s.admin.filter({ ...content('Range'), isActive: true, filters })).status).toBe(201);
    await s.runWorker();
    // US annual is 19-36; newMember 19-24 has credits 0,1,2,3,5,10.
    expect(await s.seenBy('Range', [21, 22, 23, 24])).toEqual([22, 23]);
    expect(await s.seenBy('Range')).toEqual([22, 23, 28, 29, 34, 35]);
    await s.expectQueueIdle();
  });
});

describe('spec: "Notification is only sent once at the date indicated in admin"', () => {
  it('a due-send at exactly the liveDate releases it with that liveDate; later passes send nothing more', async () => {
    const s = await scenario(db);
    const D = '2026-10-05T14:30:00Z';
    expect((await s.admin.upload({ ...content('Dated'), liveDate: D }, 'accountID\n4\n5\n')).status).toBe(
      202,
    );
    await s.runWorker();
    expect(await s.seenBy('Dated', [4, 5])).toEqual([]);

    s.clock.set(D);
    await dueSend(s);
    for (const id of [4, 5])
      expect(await mine(s, id, 'Dated')).toEqual([expect.objectContaining({ liveDate: D })]);

    s.clock.advance(DAY);
    await dueSend(s);
    s.clock.advance(10 * DAY);
    await dueSend(s);
    for (const id of [4, 5]) expect(await mine(s, id, 'Dated')).toHaveLength(1);
    expect(await s.seenBy('Dated')).toEqual([4, 5]);
    await s.expectQueueIdle();
  });
});

describe('spec: "Making a notification inactive … the notifications that already went out will not be removed"', () => {
  it('an event delivery stays visible after deactivation; a later occurrence is not delivered', async () => {
    const s = await scenario(db);
    const c = await s.admin.event({ ...content('Shipped now'), isActive: true, eventTrigger: 'shipped' });
    await record(s, 'shipped', 14, 'ship:1');
    await s.runWorker();
    const [item] = await mine(s, 14, 'Shipped now');
    expect(item).toBeDefined();

    expect((await s.admin.patch(c.body.id as string, { isActive: false })).status).toBe(200);
    await s.runWorker();
    expect(await mine(s, 14, 'Shipped now')).toEqual([item]);
    expect((await getOne(s, 14, item!.id)).status).toBe(200);

    await record(s, 'shipped', 14, 'ship:2');
    await s.runWorker();
    await dueSend(s);
    expect(await mine(s, 14, 'Shipped now')).toEqual([item]);
    await s.expectQueueIdle();
  });
});

describe('spec: "If a notification is removed, no one should see it anymore, even people it has been sent to and seen by"', () => {
  const removedIsGone = async (s: S, notificationId: string, account: number, headline: string) => {
    const [item] = await mine(s, account, headline);
    expect(item).toBeDefined();
    expect((await click(s, account, item!.id)).status).toBe(200);
    expect((await mine(s, account, headline))[0]!.isClicked).toBe(true);

    expect((await s.admin.patch(notificationId, { isRemoved: true })).status).toBe(200);
    await s.runWorker();
    expect(await mine(s, account, headline)).toEqual([]);
    const gone = await getOne(s, account, item!.id);
    const unknown = await getOne(s, account, UNKNOWN_ID);
    expect(unknown.status).toBe(404);
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual(unknown.body);
  };

  it('event notification', async () => {
    const s = await scenario(db);
    const c = await s.admin.event({ ...content('Removed event'), isActive: true, eventTrigger: 'shipped' });
    await record(s, 'shipped', 15, 'ship:r');
    await s.runWorker();
    await removedIsGone(s, c.body.id as string, 15, 'Removed event');
    await s.expectQueueIdle();
  });

  it('CSV notification', async () => {
    const s = await scenario(db);
    const up = await s.admin.upload(
      { ...content('Removed csv'), liveDate: '2026-10-05T14:30:00Z' },
      'accountID\n16\n',
    );
    expect(up.status).toBe(202);
    await s.runWorker();
    s.clock.set('2026-10-05T14:30:00Z');
    await dueSend(s);
    const rep = await s.admin.getImport(up.body.id);
    const notificationId = String(rep.body.notificationId);
    expect(rep.body.notificationId, JSON.stringify(rep.body)).toBeDefined();
    await removedIsGone(s, notificationId, 16, 'Removed csv');
    await s.expectQueueIdle();
  });
});

describe('spec: "Each notification has: icon or image, headline, subheadline, link"', () => {
  it('the delivered detail carries exactly what admin created; the list item carries headline and subheadline', async () => {
    const s = await scenario(db);
    const created = {
      image: '/img/spec-cover.png',
      headline: 'Spec content',
      subheadline: 'A distinct subheadline',
      link: '/books/spec-content',
    };
    const made = await s.admin.event({ ...created, isActive: true, eventTrigger: 'shipped' });
    expect(made.status).toBe(201);
    await record(s, 'shipped', 17, 'ship:c');
    await s.runWorker();
    const [item] = await s.member(17);
    expect(item).toMatchObject({ headline: created.headline, subheadline: created.subheadline });
    const detail = await getOne(s, 17, item!.id);
    expect(detail.status).toBe(200);
    // The API serves image and link as absolute URLs on the configured bases (as the admin response does too), so
    // "equal to what admin created" is: equal to the admin's own view of the notification, and built on the input paths.
    const pick = (b: Record<string, unknown>) => ({
      image: b.image,
      headline: b.headline,
      subheadline: b.subheadline,
      link: b.link,
    });
    expect(pick(detail.body as Record<string, unknown>)).toEqual(pick(made.body as Record<string, unknown>));
    expect(detail.body).toMatchObject({
      headline: created.headline,
      subheadline: created.subheadline,
      image: expect.stringMatching(/\/img\/spec-cover\.png$/),
      link: expect.stringMatching(/\/books\/spec-content$/),
    });
    await s.expectQueueIdle();
  });
});

describe('spec: "visible for 2 months (static months)" at the exact boundary, single GET', () => {
  it('200 one second before the first instant of M+2; 404 at it once the expiry job has run', async () => {
    const s = await scenario(db);
    s.clock.set('2026-10-15T12:00:00Z');
    await s.admin.event({ ...content('Boundary'), isActive: true, eventTrigger: 'shipped' });
    await record(s, 'shipped', 18, 'ship:b');
    await s.runWorker();
    const [item] = await s.member(18);
    expect(item).toBeDefined();

    s.clock.set('2026-11-30T23:59:59Z');
    expect((await getOne(s, 18, item!.id)).status).toBe(200);

    s.clock.set('2026-12-01T00:00:00Z');
    await expiryTimer(s.deps).run(s.deps);
    await s.runWorker();
    expect((await getOne(s, 18, item!.id)).status).toBe(404);
    await s.expectQueueIdle();
  });
});
