// §10.3 scenario tests: behaviours that exist but were not yet observed end to end through the API (B4, B16, paging,
// rate limiting, idempotent replay), driven through the real app, worker and timers.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb, updateAccount } from '../helpers/db.js';
import { scenario, content, type MemberItem } from '../helpers/scenario.js';
import { rescanTimer } from '../../src/scheduler/rescan.js';
import { expiryTimer } from '../../src/scheduler/expiry.js';
import { dueSendTimer } from '../../src/scheduler/dueSend.js';
import { housekeepingTimer } from '../../src/scheduler/housekeeping.js';
import { createScheduler, timers } from '../../src/scheduler/index.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

// Seed layout (scripts/seedAccounts.ts): US + annual + credits >= 5 is 23,24,29,30,35,36; account 22 has 3 credits.
const filters = { country: ['US'], policy: ['annual'], credits: { minimum: 5 } };
const MATCHING = [23, 24, 29, 30, 35, 36];
const START = '2026-10-04T14:30:00Z'; // the scenario clock's start

describe('scenario: filter deactivated (B4)', () => {
  it('stops the monthly resend and new matches, keeps sent deliveries and their clicks', async () => {
    const s = await scenario(db);
    const created = await s.admin.filter({ ...content('Paused'), isActive: true, filters });
    expect(created.status).toBe(201);
    await s.runWorker();
    expect(await s.seenBy('Paused')).toEqual(MATCHING);

    // Account 23 clicks; reading the list twice leaves the click as it is.
    const [item] = await s.member(23);
    const click = await s.request
      .patch(`/notifications/${item!.id}`)
      .set('X-Account-Id', '23')
      .send({ isClicked: true });
    expect(click.status).toBe(200);
    expect((await s.member(23))[0]!.isClicked).toBe(true);
    expect((await s.member(23))[0]!.isClicked).toBe(true);
    expect((await s.member(24))[0]!.isClicked).toBe(false);

    // Deactivate through the API.
    const off = await s.admin.patch(created.body.id as string, { isActive: false });
    expect(off.status).toBe(200);
    await s.runWorker();

    // A newly matching account is not sent.
    await updateAccount(db, 22, { credits: 5 });
    await s.trigger.accountChanged(22);
    await s.runWorker();
    expect(await s.member(22)).toEqual([]);

    // Next month: no resend; the October deliveries stay, and 23's stays clicked.
    s.clock.set('2026-11-01T00:10:00Z');
    await rescanTimer(s.deps).run(s.deps);
    await s.runWorker();
    for (const id of MATCHING) {
      const items = await s.member(id);
      expect(items.map((i) => [i.headline, i.liveDate])).toEqual([['Paused', START]]);
      expect(items[0]!.isClicked).toBe(id === 23);
    }
    await s.expectQueueIdle();
  });
});

describe('scenario: filter created inactive, then activated', () => {
  it('delivers nothing until PATCHed active, then fans out to the matching accounts', async () => {
    const s = await scenario(db);
    const created = await s.admin.filter({ ...content('Later'), isActive: false, filters });
    expect(created.status).toBe(201);
    await s.runWorker();
    expect(await s.seenBy('Later')).toEqual([]);

    expect((await s.admin.patch(created.body.id as string, { isActive: true })).status).toBe(200);
    await s.runWorker();
    expect(await s.seenBy('Later')).toEqual(MATCHING);
    await s.expectQueueIdle();
  });
});

describe('scenario: new-month resend (B4)', () => {
  it('adds a new delivery with its own id and the new send time, sorted first', async () => {
    const s = await scenario(db);
    expect((await s.admin.filter({ ...content('Monthly'), isActive: true, filters })).status).toBe(201);
    await s.runWorker();
    const [old] = await s.member(29);

    s.clock.set('2026-11-01T00:10:00Z');
    await rescanTimer(s.deps).run(s.deps);
    await s.runWorker();
    const items = await s.member(29);
    expect(items).toHaveLength(2);
    expect(items[0]!.id).not.toBe(old!.id);
    expect(items[0]!.liveDate).toBe('2026-11-01T00:10:00Z');
    expect(items[0]!.isClicked).toBe(false);
    expect(items[1]).toEqual(old);
    await s.expectQueueIdle();
  });
});

describe('scenario: expiry (B16)', () => {
  it('after the two-month window the member no longer sees the delivery; the admin still sees the notification', async () => {
    const s = await scenario(db);
    const created = await s.admin.filter({ ...content('Old news'), isActive: true, filters });
    await s.runWorker();
    const [item] = await s.member(35);
    expect((await s.request.get(`/notifications/${item!.id}`).set('X-Account-Id', '35')).status).toBe(200);
    expect((await s.admin.patch(created.body.id as string, { isActive: false })).status).toBe(200); // no resends
    await s.runWorker();

    // Still inside the window on the last day of November.
    s.clock.set('2026-11-30T23:00:00Z');
    await expiryTimer(s.deps).run(s.deps);
    expect((await s.member(35)).map((i) => i.id)).toEqual([item!.id]);

    s.clock.set('2026-12-01T01:00:00Z');
    await expiryTimer(s.deps).run(s.deps);
    const gone = await s.request.get(`/notifications/${item!.id}`).set('X-Account-Id', '35');
    expect(gone.status).toBe(404);
    expect(await s.member(35)).toEqual([]);
    const adminList = await s.request.get('/admin/notifications').set('X-Account-Id', '1');
    expect(adminList.status).toBe(200);
    expect((adminList.body.items as { id: string }[]).map((n) => n.id)).toContain(created.body.id);
    await s.runWorker();
    await s.expectQueueIdle();
  });
});

describe('scenario: member list ordering and paging', () => {
  it('is most recent first across all three types and a month boundary, with no gaps or duplicates when paged', async () => {
    const s = await scenario(db);
    // Filter (Oct 4 14:30).
    expect((await s.admin.filter({ ...content('F1'), isActive: true, filters })).status).toBe(201);
    await s.runWorker();
    // Immediate event (no delay), recorded at Oct 4 15:00: visible after the worker alone.
    s.clock.set('2026-10-04T15:00:00Z');
    expect((await s.admin.event({ ...content('E1'), isActive: true, eventTrigger: 'shipped' })).status).toBe(
      201,
    );
    await s.trigger.record({
      type: 'shipped',
      accountId: 23,
      occurredAt: s.clock.now(),
      occurrenceKey: 'ship:9',
    });
    await s.runWorker();
    expect((await s.member(23)).map((i) => i.headline)).toEqual(['E1', 'F1']);
    // CSV import live on Oct 20, released by the due-send timer.
    const up = await s.admin.upload(
      { ...content('C1'), liveDate: '2026-10-20T12:00:00Z' },
      'accountID\n23\n',
    );
    expect(up.status).toBe(202);
    await s.runWorker();
    s.clock.set('2026-10-20T12:01:00Z');
    await dueSendTimer(s.deps).run(s.deps);
    await s.runWorker();
    // November resend of the filter.
    s.clock.set('2026-11-01T00:10:00Z');
    await rescanTimer(s.deps).run(s.deps);
    await s.runWorker();

    const all = await s.member(23);
    expect(all.map((i) => i.headline)).toEqual(['F1', 'C1', 'E1', 'F1']);
    const times = all.map((i) => i.liveDate);
    expect([...times].sort().reverse()).toEqual(times);

    const paged: MemberItem[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const q: Record<string, string | number> = { limit: 3 };
      if (cursor) q.cursor = cursor;
      const r = await s.request.get('/notifications').query(q).set('X-Account-Id', '23');
      expect(r.status).toBe(200);
      paged.push(...(r.body.items as MemberItem[]));
      cursor = r.body.nextCursor as string | null;
      if (!cursor) break;
    }
    expect(paged).toEqual(all);
    expect(new Set(paged.map((i) => i.id)).size).toBe(4);
    await s.expectQueueIdle();
  });
});

describe('scenario: delayed event released by a scheduler tick', () => {
  it('is not visible before its due time and is visible after the scheduler ticks past it', async () => {
    const s = await scenario(db);
    expect(
      (await s.admin.event({ ...content('Tick'), isActive: true, eventTrigger: 'shipped', delay: 1 })).status,
    ).toBe(201);
    await s.trigger.record({
      type: 'shipped',
      accountId: 8,
      occurredAt: s.clock.now(),
      occurrenceKey: 'ship:t',
    });
    await s.runWorker();
    expect(await s.member(8)).toEqual([]); // release time is the liveDate (B3, sent_at)

    const scheduler = createScheduler(s.deps, timers(s.deps), { isLeader: () => true });
    s.clock.set('2026-10-05T14:31:00Z');
    await scheduler.tick(s.clock.now());
    await s.runWorker();
    expect((await s.member(8)).map((i) => [i.headline, i.liveDate])).toEqual([
      ['Tick', '2026-10-05T14:31:00Z'],
    ]);
    await s.expectQueueIdle();
  });
});

describe('scenario: lost import enqueue (§7.3 step 3, §8 housekeeping)', () => {
  it('leaves the import processing, visible to the admin, until housekeeping re-enqueues it', async () => {
    const s = await scenario(db);
    const queue = s.deps.queue;
    const realEnqueue = queue.enqueue.bind(queue);
    let dropped = 0;
    queue.enqueue = (async (...args: Parameters<typeof realEnqueue>) => {
      if (args[0] === 'process_import' && dropped === 0) {
        dropped++;
        throw new Error('broker unavailable');
      }
      return realEnqueue(...args);
    }) as typeof queue.enqueue;

    const up = await s.admin.upload(
      { ...content('Dropped'), liveDate: '2026-10-05T14:30:00Z' },
      'accountID\n4\n',
    );
    expect(up.status).toBe(202);
    expect(dropped).toBe(1);
    await s.runWorker();
    expect((await s.admin.getImport(up.body.id)).body).toMatchObject({ status: 'processing' });

    // Housekeeping before the stale threshold leaves it; after it, re-enqueues and the worker completes it.
    s.clock.set('2026-10-04T14:35:00Z');
    await housekeepingTimer(s.deps).run(s.deps);
    await s.runWorker();
    expect((await s.admin.getImport(up.body.id)).body).toMatchObject({ status: 'processing' });
    s.clock.set('2026-10-04T14:45:00Z');
    await housekeepingTimer(s.deps).run(s.deps);
    await s.runWorker();
    expect((await s.admin.getImport(up.body.id)).body).toMatchObject({ status: 'completed', accepted: 1 });
    await s.expectQueueIdle();
  });
});

describe('scenario: rate limiting on real endpoints (§9.8)', () => {
  it('429 RATE_LIMITED with Retry-After on the member list and the admin list', async () => {
    const s = await scenario(db, { config: { rateLimitMemberPerMin: 2, rateLimitAdminPerMin: 2 } });
    for (let i = 0; i < 2; i++)
      expect((await s.request.get('/notifications').set('X-Account-Id', '7')).status).toBe(200);
    const m = await s.request.get('/notifications').set('X-Account-Id', '7');
    expect(m.status).toBe(429);
    expect(m.body).toEqual({ error: 'RATE_LIMITED' });
    expect(m.headers['retry-after']).toBeDefined();

    const adminGet = () => s.request.get('/admin/notifications').set('X-Account-Id', '1');
    for (let i = 0; i < 2; i++) expect((await adminGet()).status).toBe(200);
    const a = await adminGet();
    expect(a.status).toBe(429);
    expect(a.body).toEqual({ error: 'RATE_LIMITED' });
    expect(a.headers['retry-after']).toBeDefined();
  });
});

describe('scenario: idempotent replay after a PATCH (§3 idempotent creates)', () => {
  it('returns the current representation with the original 201 and creates nothing', async () => {
    const s = await scenario(db);
    const key = randomUUID();
    const body = { ...content('Keyed'), isActive: true, filters };
    const create = () =>
      s.request
        .post('/admin/notifications/filter')
        .set('X-Account-Id', '1')
        .set('Idempotency-Key', key)
        .send(body);
    const first = await create();
    expect(first.status).toBe(201);
    await s.runWorker();
    expect((await s.admin.patch(first.body.id as string, { isActive: false })).status).toBe(200);
    await s.runWorker();

    const replay = await create();
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.isActive).toBe(false);
    const n = await db('notifications').count({ n: '*' }).first();
    expect(Number(n!.n)).toBe(1);
    await s.runWorker();
    await s.expectQueueIdle();
  });
});
