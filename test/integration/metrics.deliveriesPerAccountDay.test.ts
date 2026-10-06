import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { testDb, resetDb } from '../helpers/db.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { FixedClock } from '../helpers/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { makeDelivery, makeNotification } from '../helpers/factories.js';
import { deliveriesPerAccountDay, housekeeping } from '../../src/scheduler/housekeeping.js';
import { SEED_ACCOUNTS } from '../../scripts/seedAccounts.js';

const db = testDb();
const clock = new FixedClock(new Date('2026-10-04T14:30:00Z'));
let metrics: RecordingMetrics;
const writerForbidden = new Proxy(db, {
  get: () => {
    throw new Error('writer used');
  },
  apply: () => {
    throw new Error('writer used');
  },
}) as Knex;
const deps = () => ({ db: writerForbidden, dbReader: db, clock, metrics, log: createLogger('silent') });
const gauges = () =>
  Object.fromEntries(metrics.calls.filter((c) => c.kind === 'gauge').map((c) => [c.name, c.value]));
const EXTRA = Array.from({ length: 40 }, (_, i) => ({ ...SEED_ACCOUNTS[0]!, id: 1001 + i }));
beforeEach(async () => {
  await resetDb(db);
  metrics = new RecordingMetrics();
});
afterAll(async () => {
  await db('notification_deliveries').where('account_id', '>', 1000).delete();
  await db('accounts').where('id', '>', 1000).delete();
  await db.destroy();
});

describe('deliveries_per_account_day (reader, one-row SQL aggregate)', () => {
  it('max and nearest-rank p99 over a known distribution of 112 accounts, read through the reader only', async () => {
    await db('accounts').insert(EXTRA).onConflict('id').ignore();
    const n = await makeNotification(db, 'filter');
    const ids = [...SEED_ACCOUNTS.map((a) => a.id), ...EXTRA.map((a) => a.id)]; // 112 accounts
    const today = new Date('2026-10-04T09:00:00Z');
    for (const id of ids) await makeDelivery(db, { notification_id: n.id, account_id: id }, today);
    for (let i = 0; i < 4; i++) await makeDelivery(db, { notification_id: n.id, account_id: 1 }, today); // 5
    for (let i = 0; i < 2; i++) await makeDelivery(db, { notification_id: n.id, account_id: 2 }, today); // 3
    await deliveriesPerAccountDay(deps());
    // rank ceil(0.99 * 112) = 111 of the sorted counts [1 x110, 3, 5] -> 3
    expect(gauges()).toEqual({ deliveries_per_account_day_max: 5, deliveries_per_account_day_p99: 3 });
  });
  it('counts rows whose created_at is out of id order around midnight', async () => {
    const n = await makeNotification(db, 'filter');
    const y = new Date('2026-10-03T23:59:59Z');
    const t = new Date('2026-10-04T00:00:01Z');
    for (const [acct, at] of [
      [6, y],
      [5, t],
      [6, y],
      [6, y],
      [5, t],
      [5, t],
    ] as const)
      await makeDelivery(db, { notification_id: n.id, account_id: acct }, at);
    await deliveriesPerAccountDay(deps());
    expect(gauges()).toEqual({ deliveries_per_account_day_max: 3, deliveries_per_account_day_p99: 3 });
  });
  it('no deliveries today: both gauges are emitted as 0', async () => {
    const n = await makeNotification(db, 'filter');
    await makeDelivery(db, { notification_id: n.id, account_id: 1 }, new Date('2026-10-03T10:00:00Z'));
    await deliveriesPerAccountDay(deps());
    expect(gauges()).toEqual({ deliveries_per_account_day_max: 0, deliveries_per_account_day_p99: 0 });
  });
  it('a query over the time budget (ER_QUERY_TIMEOUT 3024) skips the gauges and never fails housekeeping', async () => {
    const n = await makeNotification(db, 'filter');
    await makeDelivery(db, { notification_id: n.id, account_id: 1 }, new Date('2026-10-04T10:00:00Z'));
    const timingOut = new Proxy(db, {
      get: (target, p, r) =>
        p === 'raw'
          ? () => Promise.reject(Object.assign(new Error('Query execution was interrupted'), { errno: 3024 }))
          : Reflect.get(target, p, r),
    }) as Knex;
    await expect(
      housekeeping(makeTestDeps({ db, dbReader: timingOut, clock, metrics })),
    ).resolves.toBeUndefined();
    expect(gauges()).toEqual({});
    expect(metrics.calls.filter((c) => c.name === 'deliveries_per_account_day_skipped')).toMatchObject([
      { kind: 'count', value: 1 },
    ]);
  });
});
