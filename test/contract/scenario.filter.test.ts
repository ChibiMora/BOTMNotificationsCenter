// §10.3 scenario tests: filter campaign and account change, end to end through the API, worker and timers.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb, updateAccount } from '../helpers/db.js';
import { scenario, content } from '../helpers/scenario.js';
import { rescanTimer } from '../../src/scheduler/rescan.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

// Seed layout (scripts/seedAccounts.ts): US 1-36 (monthly 1-18, annual 19-36), each status a block of 6 with
// credits 0,1,2,3,5,10. US + annual + credits >= 5 is therefore 23,24 (newMember), 29,30 (friend), 35,36 (bff).
const filters = { country: ['US'], policy: ['annual'], credits: { minimum: 5 } };
const MATCHING = [23, 24, 29, 30, 35, 36];

describe('scenario: filter campaign', () => {
  it('fans out, records a click, re-delivers next month, and disappears when removed', async () => {
    const s = await scenario(db);

    // 1. Admin creates an active filter notification.
    const created = await s.admin.filter({ ...content('Annual picks'), isActive: true, filters });
    expect(created.status).toBe(201);
    const notificationId = created.body.id as string;

    // 2. Worker runs the fan-out.
    await s.runWorker();

    // 3. Exactly the matching seeded accounts see it.
    expect(await s.seenBy('Annual picks')).toEqual(MATCHING);
    const [item] = await s.member(23);
    expect(item).toEqual({
      id: expect.any(String),
      headline: 'Annual picks',
      subheadline: 'Scenario',
      isClicked: false,
      liveDate: '2026-10-04T14:30:00Z',
    });

    // 4. One member clicks; only their item changes.
    const clicked = await s.request
      .patch(`/notifications/${item!.id}`)
      .set('X-Account-Id', '23')
      .send({ isClicked: true });
    expect(clicked.status).toBe(200);
    expect((await s.member(23))[0]!.isClicked).toBe(true);
    for (const id of MATCHING.filter((i) => i !== 23)) {
      expect((await s.member(id)).map((i) => i.isClicked)).toEqual([false]);
    }

    // 5. Next month: the rescan re-delivers to every matching member as a new, unclicked item.
    s.clock.set('2026-11-01T00:10:00Z');
    await rescanTimer(s.deps).run(s.deps);
    await s.runWorker();
    for (const id of MATCHING) {
      const items = (await s.member(id)).filter((i) => i.headline === 'Annual picks');
      expect(items).toHaveLength(2);
      expect(items.filter((i) => !i.isClicked)).toHaveLength(id === 23 ? 1 : 2);
    }
    expect(await s.seenBy('Annual picks')).toEqual(MATCHING);

    // 6. Admin removes it: every member's list is empty of it on the next request.
    expect((await s.admin.patch(notificationId, { isRemoved: true })).status).toBe(200);
    expect(await s.seenBy('Annual picks')).toEqual([]);
  });
});

describe('scenario: account change', () => {
  it('delivers to the one account that starts matching, and to nobody else', async () => {
    const s = await scenario(db);
    expect((await s.admin.filter({ ...content('Annual picks'), isActive: true, filters })).status).toBe(201);
    await s.runWorker();
    expect(await s.seenBy('Annual picks')).toEqual(MATCHING);
    const before = await db('notification_deliveries').count({ n: '*' }).first();

    // Account 22 (US/annual/newMember/3 credits) did not match; it gains credits and the trigger is told.
    await updateAccount(db, 22, { credits: 5 });
    await s.trigger.accountChanged(22);
    await s.runWorker();

    expect(await s.seenBy('Annual picks')).toEqual([22, ...MATCHING].sort((a, b) => a - b));
    const after = await db('notification_deliveries').count({ n: '*' }).first();
    expect(Number(after!.n)).toBe(Number(before!.n) + 1);
  });
});
