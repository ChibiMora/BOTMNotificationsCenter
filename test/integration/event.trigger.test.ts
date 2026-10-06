// Trigger end to end inside the worker (§7.1 steps 1–7): record() → real stand-in queue → event_delivery → row.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, resetDb, testConfig } from '../helpers/db.js';
import { makeTestDeps } from '../helpers/deps.js';
import { makeNotification } from '../helpers/factories.js';
import { createQueue } from '../../src/queue/index.js';
import { jobHandlers } from '../../src/jobs/index.js';
import { NotificationTrigger, createNotificationTrigger } from '../../src/trigger/index.js';
import type { Queue } from '../../src/queue/queue.js';

// Records every queue the code under test builds (delegating to the real factory) so a test can spy on it.
const built = vi.hoisted(() => [] as Queue[]);
vi.mock('../../src/queue/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/queue/index.js')>();
  return {
    ...real,
    createQueue: (...args: Parameters<typeof real.createQueue>) => {
      const q = real.createQueue(...args);
      vi.spyOn(q, 'consume'); // spied at creation, before the code under test can call it
      built.push(q);
      return q;
    },
  };
});

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());
const step = (q: unknown) => (q as { runOnce(): Promise<number> }).runOnce();

describe('trigger end to end', () => {
  it('record() through the db stand-in queue runs event_delivery once and writes the expected rows', async () => {
    const config = { ...testConfig(), queueImpl: 'db' as const };
    const base = makeTestDeps({ db, config });
    const queue = createQueue(config, {
      db,
      clock: base.clock,
      log: base.log,
      metrics: base.metrics,
      manual: true,
    } as Parameters<typeof createQueue>[1]);
    const deps = { ...base, queue };
    const now = base.clock.now();
    const live = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true });
    const later = await makeNotification(db, 'event', { event_trigger: 'shipped', active: true, delay: 2 });
    const handle = await queue.consume(jobHandlers(deps), { onDead: async () => {} });
    await new NotificationTrigger(deps).record({
      type: 'shipped',
      accountId: 5,
      occurredAt: new Date('2026-10-04T12:00:00Z'),
      occurrenceKey: 'shipment:77',
    });
    expect(await step(queue)).toBe(1);
    expect(await step(queue)).toBe(0);
    await handle.stop();
    const rows = await db('notification_deliveries').where({ account_id: 5 }).orderBy('notification_id');
    expect(rows.map((r) => [r.notification_id, r.dedupe_key, new Date(r.due_at).toISOString()])).toEqual([
      [live.id, 'shipment:77', '2026-10-04T12:00:00.000Z'],
      [later.id, 'shipment:77', '2026-10-06T12:00:00.000Z'],
    ]);
    expect(rows.map((r) => r.occurrence_key)).toEqual(rows.map((r) => r.dedupe_key));
    expect(rows.every((r) => typeof r.occurrence_key === 'string' && r.occurrence_key.length > 0)).toBe(true);
    expect(new Date(rows[0].sent_at).getTime()).toBe(now.getTime());
    expect(rows[1].sent_at).toBeNull();
  });
});

describe('createNotificationTrigger is enqueue-only', () => {
  it('never starts a consumer: the recorded job stays queued with attempts 0 and consume is never called', async () => {
    built.length = 0;
    const config = { ...testConfig(), queueImpl: 'db' as const };
    const trigger = createNotificationTrigger(config);
    expect(built).toHaveLength(1);
    const consume = vi.mocked(built[0]!.consume);
    await trigger.record({
      type: 'shipped',
      accountId: 1,
      occurredAt: new Date('2026-10-04T14:00:00Z'),
      occurrenceKey: 'shipment:consumer-check',
    });
    // Give any (wrongly) started consumer loop a chance to claim the job: several macrotask turns, no sleeping.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const jobs = await db('jobs').select('type', 'status', 'attempts');
    expect(jobs).toEqual([{ type: 'event_delivery', status: 'queued', attempts: 0 }]);
    expect(consume).not.toHaveBeenCalled();
  });
});
