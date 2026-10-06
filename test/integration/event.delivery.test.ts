// event_delivery (§7.1 event flow, §8.2 row; B9, B10) against the real database and seeded accounts.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { makeNotification } from '../helpers/factories.js';
import { eventDelivery } from '../../src/jobs/eventDelivery.js';
import { NotificationTrigger } from '../../src/trigger/index.js';
import { jobHandlers as handlers } from '../../src/jobs/index.js';
import type { FakeQueue } from '../helpers/fakeQueue.js';
import type { Deps } from '../../src/lib/deps.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
const ctx = { attempt: 1, heartbeat: async () => {} };
const rows = () => db('notification_deliveries').orderBy('notification_id');
const ms = (d: unknown) => new Date(d as Date).getTime();
const NOW = new Date('2026-10-04T14:30:00Z');
const payload = (
  o: Partial<{ type: any; accountId: number; occurredAt: string; occurrenceKey: string }> = {},
) => ({
  type: 'shipped' as const,
  accountId: 1,
  occurredAt: '2026-10-04T14:00:00Z',
  occurrenceKey: 'shipment:1',
  ...o,
});
const counted = (deps: Deps, name: string) =>
  (deps.metrics as RecordingMetrics).calls.filter((c) => c.name === name).reduce((s, c) => s + c.value, 0);

describe('event_delivery', () => {
  it('immediate event: one live delivery, sent_at = clock, dedupe_key = occurrence_key', async () => {
    const deps = makeTestDeps({ db });
    const n = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    await eventDelivery(deps, payload(), ctx);
    const got = await rows();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      notification_id: n.id,
      account_id: 1,
      dedupe_key: 'shipment:1',
      occurrence_key: 'shipment:1',
    });
    expect(ms(got[0].sent_at)).toBe(NOW.getTime());
    expect(ms(got[0].due_at)).toBe(ms('2026-10-04T14:00:00Z'));
  });

  it('delayed event (5 days): scheduled with due_at = occurredAt + 5 days, sent_at null', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 5 });
    await eventDelivery(deps, payload(), ctx);
    const [d] = await rows();
    expect(d.sent_at).toBeNull();
    expect(ms(d.due_at)).toBe(ms('2026-10-09T14:00:00Z'));
  });

  it('preenrollAudiobook is immediate even when the notification has a delay', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'preenrollAudiobook', active: true, delay: 7 });
    await eventDelivery(deps, payload({ type: 'preenrollAudiobook', occurrenceKey: 'audiobook:3:1' }), ctx);
    const [d] = await rows();
    expect(ms(d.sent_at)).toBe(NOW.getTime());
    expect(ms(d.due_at)).toBe(ms('2026-10-04T14:00:00Z'));
  });

  it('inactive, removed, or other-trigger notifications get nothing', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: false });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, removed: true });
    await makeNotification(db, 'event', { event_trigger: 'enrolled', active: true });
    await eventDelivery(deps, payload(), ctx);
    expect(await rows()).toEqual([]);
  });

  it('two notifications on one event: two deliveries', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 2 });
    await eventDelivery(deps, payload(), ctx);
    expect(await rows()).toHaveLength(2);
    expect(counted(deps, 'event_delivery_inserted')).toBe(2);
  });

  it('record() twice with one key → one delivery; with two keys → two', async () => {
    const deps = makeTestDeps({ db });
    const q = deps.queue as FakeQueue;
    await q.consume(handlers(deps), { onDead: async () => {} });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    const t = new NotificationTrigger(deps);
    const e = {
      type: 'shipped' as const,
      accountId: 1,
      occurredAt: new Date('2026-10-04T14:00:00Z'),
      occurrenceKey: 'k1',
    };
    await t.record(e);
    await t.record(e);
    await q.runAll();
    expect(await rows()).toHaveLength(1);
    await t.record({ ...e, occurrenceKey: 'k2' });
    await q.runAll();
    expect(await rows()).toHaveLength(2);
  });

  it('the same job run twice concurrently yields one delivery per notification', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 3 });
    await Promise.all([eventDelivery(deps, payload(), ctx), eventDelivery(deps, payload(), ctx)]);
    expect(await rows()).toHaveLength(2);
  });

  it('an old event whose due_at is before the window start is dropped and counted', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 2 });
    await eventDelivery(deps, payload({ occurredAt: '2026-08-20T00:00:00Z' }), ctx);
    expect(await rows()).toEqual([]);
    expect(counted(deps, 'event_delivery_too_old')).toBe(1);
  });

  it('unknown account: no delivery, no throw, logged', async () => {
    const deps = makeTestDeps({ db });
    const warn = vi.spyOn(deps.log, 'warn');
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    await expect(eventDelivery(deps, payload({ accountId: 999_999 }), ctx)).resolves.toBeUndefined();
    expect(await rows()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ accountId: 999_999 }), expect.any(String));
  });

  it('also runs the per-account filter check, including when no event notification matches', async () => {
    const deps = makeTestDeps({ db });
    const f = await makeNotification(db, 'filter', { active: true });
    await eventDelivery(deps, payload({ type: 'enrolled' }), ctx);
    expect((await rows()).map((r) => r.notification_id)).toEqual([f.id]);
    const e = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    await eventDelivery(deps, payload({ accountId: 2 }), ctx);
    const two = await db('notification_deliveries').where({ account_id: 2 }).orderBy('notification_id');
    expect(two.map((r) => r.notification_id)).toEqual([f.id, e.id]);
  });

  it('trigger safety: a rejecting queue increments the metric; accountChanged → account_recheck → delivery', async () => {
    const deps = makeTestDeps({ db });
    const q = deps.queue as FakeQueue;
    const t = new NotificationTrigger(deps);
    q.failNextEnqueue(new Error('queue down'));
    await expect(
      t.record({ type: 'shipped', accountId: 1, occurredAt: NOW, occurrenceKey: 'x' }),
    ).resolves.toBeUndefined();
    expect(counted(deps, 'trigger_enqueue_failed')).toBe(1);
    await q.consume(handlers(deps), { onDead: async () => {} });
    const f = await makeNotification(db, 'filter', { active: true });
    await t.accountChanged(3);
    expect(q.enqueued.at(-1)).toEqual({ type: 'account_recheck', payload: { accountId: 3 } });
    await q.runAll();
    expect((await rows()).map((r) => [r.notification_id, r.account_id])).toEqual([[f.id, 3]]);
  });
});

describe('event_delivery timing details', () => {
  it('one fresh now per insert: sent_at equals created_at with a clock that advances on every reading', async () => {
    let t = NOW.getTime();
    const clock = { now: () => new Date((t += 1000)) };
    const deps = makeTestDeps({ db, clock } as never);
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 0 });
    await eventDelivery(deps, payload(), ctx);
    const [r] = await rows();
    expect(r.sent_at).not.toBeNull();
    expect(ms(r.sent_at)).toBe(ms(r.created_at));
  });

  it('due_at exactly on the window start is delivered; one second before is dropped', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 0 });
    // NOW = 2026-10-04 → window start 2026-09-01T00:00:00Z
    await eventDelivery(deps, payload({ occurredAt: '2026-09-01T00:00:00Z', occurrenceKey: 'on' }), ctx);
    await eventDelivery(deps, payload({ occurredAt: '2026-08-31T23:59:59Z', occurrenceKey: 'before' }), ctx);
    expect((await rows()).map((r) => r.dedupe_key)).toEqual(['on']);
    expect(counted(deps, 'event_delivery_too_old')).toBe(1);
  });

  it('accountChanged() with a queue whose next enqueue fails resolves and counts the failure', async () => {
    const deps = makeTestDeps({ db });
    const queue = deps.queue as FakeQueue;
    queue.failNextEnqueue(new Error('queue down'));
    const t = new NotificationTrigger(deps);
    await expect(t.accountChanged(1)).resolves.toBeUndefined();
    expect(counted(deps, 'trigger_enqueue_failed')).toBe(1);
    expect(queue.enqueued.filter((j) => j.type === 'account_recheck')).toEqual([]);
  });
});

describe('event_delivery protects itself from a bad payload (no throw, no retry, no dead-letter)', () => {
  const bad: Array<[string, string, Parameters<typeof payload>[0]]> = [
    ['missing occurredAt', 'occurredAt', { occurredAt: undefined as unknown as string }],
    ['invalid occurredAt', 'occurredAt', { occurredAt: 'not-a-date' }],
    ['unknown type', 'type', { type: 'refunded' }],
    ['zero accountId', 'accountId', { accountId: 0 }],
    ['negative accountId', 'accountId', { accountId: -3 }],
    ['non-integer accountId', 'accountId', { accountId: 1.5 }],
    ['empty occurrenceKey', 'occurrenceKey', { occurrenceKey: '' }],
    ['over-128-character occurrenceKey', 'occurrenceKey', { occurrenceKey: 'k'.repeat(129) }],
  ];
  for (const [label, field, o] of bad) {
    it(`${label}: logged and counted, nothing inserted, returns`, async () => {
      const deps = makeTestDeps({ db });
      const warn = vi.spyOn(deps.log, 'warn');
      await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
      await expect(eventDelivery(deps, payload(o), ctx)).resolves.toBeUndefined();
      expect(await rows()).toEqual([]);
      expect(counted(deps, 'event_delivery_invalid_payload')).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ invalid: field }), expect.any(String));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('k'.repeat(129));
    });
  }

  it('a 128-character occurrenceKey is accepted', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    await eventDelivery(deps, payload({ occurrenceKey: 'k'.repeat(128) }), ctx);
    expect(await rows()).toHaveLength(1);
    expect(counted(deps, 'event_delivery_invalid_payload')).toBe(0);
  });
});

describe('event_delivery rejects an occurredAt that is not a strict, in-range UTC timestamp', () => {
  const badAt: Array<[string, string]> = [
    ['a local-time date string', 'Oct 5 2026'],
    ['a bare number', '1'],
    ['no Z suffix', '2026-10-04T14:00:00'],
    ['an offset instead of Z', '2026-10-04T14:00:00+02:00'],
    ['an impossible calendar date', '2026-02-30T00:00:00Z'],
    ['a far-future year 9999', '9999-12-31T00:00:00Z'],
    ['an extended-year timestamp', '+275760-09-13T00:00:00Z'],
    ['a year before 1000', '0999-12-31T23:59:59Z'],
  ];
  for (const [label, occurredAt] of badAt) {
    it(`${label} (${occurredAt}): logged and counted as invalid, nothing inserted, no throw`, async () => {
      const deps = makeTestDeps({ db });
      const warn = vi.spyOn(deps.log, 'warn');
      await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
      await expect(eventDelivery(deps, payload({ occurredAt }), ctx)).resolves.toBeUndefined();
      expect(await rows()).toEqual([]);
      expect(counted(deps, 'event_delivery_invalid_payload')).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ invalid: 'occurredAt' }),
        expect.any(String),
      );
    });
  }

  it('fractional seconds with Z are accepted', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    await eventDelivery(deps, payload({ occurredAt: '2026-10-04T14:00:00.123Z' }), ctx);
    expect(await rows()).toHaveLength(1);
  });

  it('a due_at computed past 9998-12-31 is an invalid payload: counted, nothing inserted, no throw', async () => {
    const deps = makeTestDeps({ db });
    await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 5 });
    await expect(
      eventDelivery(deps, payload({ occurredAt: '9998-12-30T00:00:00Z' }), ctx),
    ).resolves.toBeUndefined();
    expect(await rows()).toEqual([]);
    expect(counted(deps, 'event_delivery_invalid_payload')).toBe(1);
  });

  for (const [label, p] of [
    ['null', null],
    ['a number', 42],
    ['a string', 'shipped'],
  ] as const) {
    it(`a ${label} payload is counted as invalid, not a TypeError`, async () => {
      const deps = makeTestDeps({ db });
      await expect(eventDelivery(deps, p as never, ctx)).resolves.toBeUndefined();
      expect(counted(deps, 'event_delivery_invalid_payload')).toBe(1);
    });
  }
});
