// §10.3 scenario tests: event notifications (delay, pre-order, deactivate while pending, visibility window).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db.js';
import { scenario, content, DAY } from '../helpers/scenario.js';
import { dueSendTimer } from '../../src/scheduler/dueSend.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');

describe('scenario: event with delay', () => {
  it('holds the delivery until the release time, then dedupes by occurrence key', async () => {
    const s = await scenario(db);

    // 1. Admin creates an active `shipped` notification with a 5-day delay.
    const c = await s.admin.event({
      ...content('Shipped'),
      isActive: true,
      eventTrigger: 'shipped',
      delay: 5,
    });
    expect(c.status).toBe(201);

    // 2. The event is recorded for account 7 and the worker runs: nothing is visible yet.
    const occurredAt = s.clock.now();
    await s.trigger.record({ type: 'shipped', accountId: 7, occurredAt, occurrenceKey: 'shipment:1' });
    await s.runWorker();
    expect(await s.member(7)).toEqual([]);

    // 3. Five days later the due-send pass releases it, with liveDate = the release time.
    s.clock.advance(5 * DAY);
    await dueSendTimer(s.deps).run(s.deps);
    await s.runWorker();
    const items = await s.member(7);
    expect(items).toEqual([
      expect.objectContaining({
        headline: 'Shipped',
        isClicked: false,
        liveDate: iso(new Date(occurredAt.getTime() + 5 * DAY)),
      }),
    ]);

    // 4. Same occurrence key again: still one item.
    await s.trigger.record({ type: 'shipped', accountId: 7, occurredAt, occurrenceKey: 'shipment:1' });
    await s.runWorker();
    s.clock.advance(5 * DAY);
    await dueSendTimer(s.deps).run(s.deps);
    expect(await s.member(7)).toHaveLength(1);

    // 5. A new occurrence key: after its delay and the due-send pass, two items.
    await s.trigger.record({
      type: 'shipped',
      accountId: 7,
      occurredAt: s.clock.now(),
      occurrenceKey: 'shipment:2',
    });
    await s.runWorker();
    expect(await s.member(7)).toHaveLength(1);
    s.clock.advance(5 * DAY);
    await dueSendTimer(s.deps).run(s.deps);
    expect(await s.member(7)).toHaveLength(2);
    expect(await s.seenBy('Shipped')).toEqual([7]);
  });
});

describe('scenario: pre-order', () => {
  it('delivers a preenrollAudiobook notification immediately, ignoring its delay', async () => {
    const s = await scenario(db);
    const c = await s.admin.event({
      ...content('Preorder'),
      isActive: true,
      eventTrigger: 'preenrollAudiobook',
      delay: 3,
    });
    expect(c.status).toBe(201);
    await s.trigger.record({
      type: 'preenrollAudiobook',
      accountId: 9,
      occurredAt: s.clock.now(),
      occurrenceKey: 'pre:1',
    });
    await s.runWorker();
    expect(await s.member(9)).toEqual([
      expect.objectContaining({ headline: 'Preorder', isClicked: false, liveDate: '2026-10-04T14:30:00Z' }),
    ]);
  });
});

describe('scenario: deactivate while pending', () => {
  it('drops a pending delivery when deactivated; only occurrences after reactivation appear', async () => {
    const s = await scenario(db);
    const c = await s.admin.event({
      ...content('Paused'),
      isActive: true,
      eventTrigger: 'shipped',
      delay: 2,
    });
    const id = c.body.id as string;

    // 1. Delayed event recorded, then the admin deactivates.
    await s.trigger.record({
      type: 'shipped',
      accountId: 8,
      occurredAt: s.clock.now(),
      occurrenceKey: 'old',
    });
    await s.runWorker();
    expect((await s.admin.patch(id, { isActive: false })).status).toBe(200);
    await s.runWorker();

    // 2. Past the delay, due-send: nothing appears.
    s.clock.advance(3 * DAY);
    await dueSendTimer(s.deps).run(s.deps);
    await s.runWorker();
    expect(await s.member(8)).toEqual([]);

    // 3. Reactivated: still nothing for the old occurrence.
    expect((await s.admin.patch(id, { isActive: true })).status).toBe(200);
    await s.runWorker();
    await dueSendTimer(s.deps).run(s.deps);
    expect(await s.member(8)).toEqual([]);

    // 4. A new occurrence after reactivation appears after its delay.
    await s.trigger.record({
      type: 'shipped',
      accountId: 8,
      occurredAt: s.clock.now(),
      occurrenceKey: 'new',
    });
    await s.runWorker();
    s.clock.advance(2 * DAY);
    await dueSendTimer(s.deps).run(s.deps);
    expect(await s.member(8)).toEqual([expect.objectContaining({ headline: 'Paused' })]);
  });
});

describe('scenario: visibility window', () => {
  it('a delivery sent on the last second of a month is visible next month and gone the month after', async () => {
    const s = await scenario(db);
    s.clock.set('2026-10-31T23:59:59Z');
    await s.admin.event({ ...content('Edge'), isActive: true, eventTrigger: 'shipped' });
    await s.trigger.record({
      type: 'shipped',
      accountId: 10,
      occurredAt: s.clock.now(),
      occurrenceKey: 'edge',
    });
    await s.runWorker();
    expect(await s.member(10)).toEqual([
      expect.objectContaining({ headline: 'Edge', liveDate: '2026-10-31T23:59:59Z' }),
    ]);

    s.clock.set('2026-11-30T23:59:59Z'); // last second of the next month: still visible
    expect(await s.member(10)).toHaveLength(1);
    s.clock.set('2026-12-01T00:00:00Z'); // first second of the month after: gone
    expect(await s.member(10)).toEqual([]);
  });
});
