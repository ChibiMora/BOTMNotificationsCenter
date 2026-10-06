// Expiry (§8.3): out-of-window live deliveries move to the archive byte for byte, in budgeted, batched transactions.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Knex } from 'knex';
import { testDb, testConfig, resetDb } from '../helpers/db.js';
import { recordLocks } from '../helpers/locks.js';
import { makeTestDeps, RecordingMetrics } from '../helpers/deps.js';
import { makeNotification, makeDelivery } from '../helpers/factories.js';
import { FixedClock } from '../helpers/clock.js';
import { expire, expiryCandidates, expiryLockStep, expiryTimer } from '../../src/scheduler/expiry.js';
import type { Deps } from '../../src/lib/deps.js';
import type { DeliveryRow } from '../../src/lib/rows.js';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

const NOW = new Date('2026-10-01T00:00:00Z');
const COLUMNS = [
  'id',
  'public_id',
  'notification_id',
  'account_id',
  'is_clicked',
  'sent_at',
  'due_at',
  'occurrence_key',
  'dedupe_key',
  'created_at',
] as const;

function deps(o: { expiryBatch?: number; expiryDailyRowBudget?: number; db?: Knex; now?: Date } = {}): Deps {
  const { db: d = db, now = NOW, ...cfg } = o;
  return makeTestDeps({ db: d, config: { ...testConfig(), ...cfg }, clock: new FixedClock(now) });
}
/** Wraps `d.db.transaction` so `hold(trx, n)` runs after the n-th batch's work and before its commit. */
function hookTransactions(d: Deps, hold: (trx: Knex.Transaction, n: number) => Promise<void>) {
  const real = d.db;
  let n = 0;
  d.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
      return (fn: (trx: Knex.Transaction) => Promise<unknown>) =>
        target.transaction(async (trx) => {
          const r = await fn(trx);
          await hold(trx, ++n);
          return r;
        });
    },
  });
}
/**
 * Wraps `d.db` to count candidate reads (calls of the db as a query builder) and batch transactions. Past `cap` of
 * either it throws, so a run that would spin fails fast instead of hanging.
 */
function countCalls(d: Deps, cap = 20) {
  const counts = { reads: 0, transactions: 0 };
  const guard = (k: keyof typeof counts) => {
    if (++counts[k] > cap) throw new Error(`iteration cap: more than ${cap} ${k}`);
  };
  d.db = new Proxy(d.db, {
    apply(target, thisArg, args) {
      guard('reads');
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop, receiver) {
      if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
      return (fn: (trx: Knex.Transaction) => Promise<unknown>) => {
        guard('transactions');
        return target.transaction(fn);
      };
    },
  });
  return counts;
}
type LogCall = { level: string; obj: Record<string, unknown>; msg: string };
/** Replaces `d.log` with a logger that records every call. */
function recordLog(d: Deps) {
  const calls: LogCall[] = [];
  const at =
    (level: string) =>
    (obj: Record<string, unknown>, msg = '') =>
      calls.push({ level, obj, msg });
  const log = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  d.log = { ...log, fatal: at('fatal'), child: () => d.log } as unknown as Deps['log'];
  return calls;
}
const runComplete = (calls: LogCall[]) => calls.filter((c) => c.msg === 'expiry run complete');
const stopped = (d: Deps) =>
  (d.metrics as RecordingMetrics).calls.filter((c) => c.name === 'expiry_run_stopped').map((c) => c.dims);
const deliveryRecordLocks = async () => (await recordLocks(db, 'notification_deliveries')).length;
const HEX_COLUMNS = `id, HEX(public_id) AS public_id, notification_id, account_id, is_clicked,
  CAST(sent_at AS CHAR) AS sent_at, CAST(due_at AS CHAR) AS due_at, HEX(occurrence_key) AS occurrence_key,
  HEX(dedupe_key) AS dedupe_key, CAST(created_at AS CHAR) AS created_at`;
const hotIds = () => db('notification_deliveries').orderBy('id').pluck('id');
const archivedIds = () => db('archived_notification_deliveries').orderBy('id').pluck('id');
const archivedCount = (d: Deps) =>
  (d.metrics as RecordingMetrics).calls
    .filter((c) => c.name === 'expiry_rows_archived')
    .reduce((s, c) => s + c.value, 0);

/** `n` expired live deliveries with distinct sent_at (oldest first), returned in sent_at order. */
async function expired(n: number) {
  const notification = await makeNotification(db, 'event');
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      await makeDelivery(db, {
        notification_id: notification.id,
        account_id: (i % 70) + 1,
        sent_at: new Date(Date.UTC(2026, 7, 1, 0, 0, n - i)), // inserted newest first: id order != sent_at order
        dedupe_key: `k${i}`,
      }),
    );
  }
  return rows.sort((a, b) => a.sent_at!.getTime() - b.sent_at!.getTime());
}

describe('expiry', () => {
  it('moves out-of-window rows to the archive byte for byte and leaves in-window and scheduled rows', async () => {
    const d = deps();
    const n = await makeNotification(db, 'event');
    const created = new Date('2026-07-15T08:09:10Z');
    const old1 = await makeDelivery(
      db,
      {
        notification_id: n.id,
        account_id: 1,
        public_id: 'dl_AbCdEfGhIjKl',
        is_clicked: true,
        sent_at: new Date('2026-08-31T23:59:59Z'),
        due_at: new Date('2026-08-30T12:00:00Z'),
        occurrence_key: 'Order-17 ',
        dedupe_key: 'Evt:Order-17 ',
      },
      created,
    );
    const old2 = await makeDelivery(
      db,
      {
        notification_id: n.id,
        account_id: 2,
        public_id: 'dl_abcdefghijkl',
        is_clicked: false,
        sent_at: new Date('2025-01-02T03:04:05Z'),
        due_at: new Date('2025-01-01T00:00:00Z'),
        occurrence_key: null,
        dedupe_key: 'MixedCase ',
      },
      created,
    );
    const inWindow = await makeDelivery(db, {
      notification_id: n.id,
      account_id: 3,
      sent_at: new Date('2026-09-01T00:00:00Z'),
    });
    const scheduled = await makeDelivery(db, {
      notification_id: n.id,
      account_id: 4,
      sent_at: null,
      due_at: new Date('2020-01-01T00:00:00Z'),
    });
    const before = await db('notification_deliveries').whereIn('id', [old1.id, old2.id]).orderBy('id');

    await expiryTimer(d).run(d);

    expect(await hotIds()).toEqual([inWindow.id, scheduled.id].sort((a, b) => a - b));
    const after = await db('archived_notification_deliveries').orderBy('id');
    expect(after.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c]])))).toEqual(
      before.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c]]))),
    );
    expect(after[0].public_id).toBe('dl_AbCdEfGhIjKl');
    expect(after.map((r) => r.archived_at)).toEqual([NOW, NOW]);
    expect(archivedCount(d)).toBe(2);
  });

  it('archives rows of removed and inactive notifications like any other', async () => {
    const d = deps();
    const removed = await makeNotification(db, 'event', { removed: true });
    const inactive = await makeNotification(db, 'filter', { active: false });
    const sent_at = new Date('2026-08-10T00:00:00Z');
    await makeDelivery(db, { notification_id: removed.id, account_id: 1, sent_at });
    await makeDelivery(db, { notification_id: inactive.id, account_id: 1, sent_at });
    await expiryTimer(d).run(d);
    expect(await hotIds()).toEqual([]);
    expect(await archivedIds()).toHaveLength(2);
  });

  it('archives every expired row across several small batches, in sent_at, due_at, id order', async () => {
    const d = deps({ expiryBatch: 3 });
    // Pairs share sent_at; within a pair the later-inserted (higher id) row has the earlier due_at, so the
    // (sent_at, due_at, id) order differs from (sent_at, id) and batch boundaries (every 3) split pairs.
    const notification = await makeNotification(db, 'event');
    const rows: DeliveryRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(
        await makeDelivery(db, {
          notification_id: notification.id,
          account_id: i + 1,
          sent_at: new Date(Date.UTC(2026, 7, 1, 0, 0, Math.floor(i / 2))),
          due_at: new Date(Date.UTC(2026, 6, 1, 0, 0, 10 - i)),
          dedupe_key: `k${i}`,
        }),
      );
    }
    rows.sort(
      (a, b) =>
        a.sent_at!.getTime() - b.sent_at!.getTime() || a.due_at.getTime() - b.due_at.getTime() || a.id - b.id,
    );
    const order: number[] = [];
    let transactions = 0;
    hookTransactions(d, async (trx) => {
      transactions++;
      order.push(...(await trx('archived_notification_deliveries').whereNotIn('id', order).pluck('id')));
    });
    await expire(d);
    expect(transactions).toBeGreaterThanOrEqual(4);
    expect(await hotIds()).toEqual([]);
    expect(order.length).toBe(10);
    // Each batch takes the oldest remaining rows: batch contents match (sent_at, due_at, id) order chunked by 3.
    const chunks = [0, 3, 6, 9].map((i) =>
      rows
        .slice(i, i + 3)
        .map((r) => r.id)
        .sort((a, b) => a - b),
    );
    expect([0, 3, 6, 9].map((i) => order.slice(i, i + 3).sort((a, b) => a - b))).toEqual(chunks);
    expect(archivedCount(d)).toBe(10);
  });

  it('archives at most the daily budget, oldest first; the next run takes the next rows', async () => {
    const d = deps({ expiryBatch: 2, expiryDailyRowBudget: 5 });
    const rows = await expired(12);
    const ids = rows.map((r) => r.id);
    await expire(d);
    expect(await archivedIds()).toEqual(ids.slice(0, 5).sort((a, b) => a - b));
    await expire(d);
    expect(await archivedIds()).toEqual(ids.slice(0, 10).sort((a, b) => a - b));
    expect(archivedCount(d)).toBe(10);
  });

  it('running twice archives nothing new and does not fail; nothing to do counts zero', async () => {
    const d = deps();
    await expired(4);
    await expire(d);
    const first = await db('archived_notification_deliveries').orderBy('id');
    const d2 = deps();
    await expect(expire(d2)).resolves.toBe(0);
    expect(await db('archived_notification_deliveries').orderBy('id')).toEqual(first);
    expect(archivedCount(d2)).toBe(0);
  });

  it('two overlapping runs archive every row exactly once', async () => {
    const rows = await expired(40);
    const other = testDb();
    try {
      const a = deps({ expiryBatch: 3 });
      const b = deps({ expiryBatch: 3, db: other });
      const results = await Promise.all([expire(a), expire(b)]);
      expect(results[0]! + results[1]!).toBe(40);
    } finally {
      await other.destroy();
    }
    expect(await hotIds()).toEqual([]);
    expect(await archivedIds()).toEqual(rows.map((r) => r.id).sort((a, b) => a - b));
  });

  it('a failure mid-run leaves every row in exactly one table', async () => {
    const d = deps({ expiryBatch: 3 });
    const rows = await expired(10);
    let transactions = 0;
    const real = d.db;
    d.db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
        return (fn: (trx: Knex.Transaction) => Promise<unknown>) =>
          target.transaction(async (trx) => {
            const r = await fn(trx);
            if (++transactions === 2) throw new Error('injected failure after the second batch delete');
            return r;
          });
      },
    });
    await expect(expire(d)).rejects.toThrow('injected failure');
    const hot = await hotIds();
    const archived = await archivedIds();
    expect(archived).toEqual(
      rows
        .slice(0, 3)
        .map((r) => r.id)
        .sort((a, b) => a - b),
    );
    expect([...hot, ...archived].sort((a, b) => a - b)).toEqual(rows.map((r) => r.id).sort((a, b) => a - b));
    // A rerun completes the move.
    await expire(deps({ expiryBatch: 3 }));
    expect(await hotIds()).toEqual([]);
    expect(await archivedIds()).toHaveLength(10);
  });

  it('a batch locks only its own rows, not the expired backlog', async () => {
    const d = deps({ expiryBatch: 3 });
    await expired(300);
    const locks: number[] = [];
    hookTransactions(d, async (_trx, n) => {
      if (n === 1) locks.push(await deliveryRecordLocks());
    });
    await expire({ ...d, config: { ...d.config, expiryDailyRowBudget: 3 } });
    expect(locks).toHaveLength(1);
    expect(locks[0]).toBeGreaterThan(0);
    expect(locks[0]).toBeLessThanOrEqual(30);
  });

  it('the candidate read is served by idx_due_send without a filesort', async () => {
    await expired(50);
    const { sql, bindings } = expiryCandidates(db, new Date('2026-09-01T00:00:00Z'), 3).toSQL();
    const [plan] = await db.raw(`EXPLAIN FORMAT=JSON ${sql}`, bindings as Knex.RawBinding[]);
    const json = JSON.stringify(JSON.parse(plan[0].EXPLAIN));
    expect(json).toContain('"key":"idx_due_send"');
    expect(json).not.toContain('"using_filesort":true');
    expect(sql).not.toMatch(/for update/i);
  });

  it('overlapping runs both make progress: B skips the rows A holds and archives the rest', async () => {
    const rows = await expired(40);
    const other = testDb();
    let heldByA: number[] = [];
    let bResult = -1;
    let bArchivedWhileAHeld: number[] = [];
    try {
      const a = deps({ expiryBatch: 3 });
      const b = deps({ expiryBatch: 10, db: other });
      hookTransactions(a, async (trx, n) => {
        if (n !== 1) return;
        heldByA = await trx('archived_notification_deliveries').orderBy('id').pluck('id');
        bResult = await expire(b); // runs to completion while A's first batch is still open
        bArchivedWhileAHeld = await other('archived_notification_deliveries').orderBy('id').pluck('id');
      });
      const aResult = await expire(a);
      expect(heldByA).toHaveLength(3);
      expect(bResult).toBeGreaterThan(0);
      expect(aResult).toBeGreaterThan(0);
      expect(aResult + bResult).toBe(40);
      expect(bArchivedWhileAHeld).toHaveLength(bResult);
      expect(bArchivedWhileAHeld.filter((id) => heldByA.includes(id))).toEqual([]);
    } finally {
      await other.destroy();
    }
    expect(await hotIds()).toEqual([]);
    expect(await archivedIds()).toEqual(rows.map((r) => r.id).sort((a, b) => a - b));
  });

  it('a full candidate read that locks nothing stops the run at once (contended) instead of spinning', async () => {
    const rows = await expired(10);
    const other = testDb();
    let bResult = -1;
    let bArchived: number[] = [-1];
    try {
      const a = deps({ expiryBatch: 3 });
      const b = deps({ expiryBatch: 3, db: other });
      const bCounts = countCalls(b);
      const bLog = recordLog(b);
      hookTransactions(a, async (_trx, n) => {
        if (n !== 1) return;
        bResult = await expire(b); // every candidate B reads is one of the 3 rows A's open batch holds
        bArchived = await other('archived_notification_deliveries').pluck('id');
      });
      const aResult = await expire(a);
      expect(bResult).toBe(0);
      expect(bCounts).toEqual({ reads: 1, transactions: 1 });
      expect(bArchived).toEqual([]);
      expect(aResult).toBe(10);
      expect(runComplete(bLog)).toEqual([
        { level: 'warn', obj: { archived: 0, stopReason: 'contended' }, msg: 'expiry run complete' },
      ]);
      expect(stopped(b)).toEqual([{ reason: 'contended' }]);
    } finally {
      await other.destroy();
    }
    expect(await hotIds()).toEqual([]);
    expect(await archivedIds()).toEqual(rows.map((r) => r.id).sort((a, b) => a - b));
  });

  it('a drained backlog logs stopReason drained at info and counts expiry_run_stopped{reason: drained}', async () => {
    const d = deps({ expiryBatch: 3 });
    const log = recordLog(d);
    await expired(7);
    await expect(expire(d)).resolves.toBe(7);
    const empty = deps({ expiryBatch: 3 });
    const emptyLog = recordLog(empty);
    await expect(expire(empty)).resolves.toBe(0);
    expect(runComplete(log)).toEqual([
      { level: 'info', obj: { archived: 7, stopReason: 'drained' }, msg: 'expiry run complete' },
    ]);
    expect(runComplete(emptyLog)).toEqual([
      { level: 'info', obj: { archived: 0, stopReason: 'drained' }, msg: 'expiry run complete' },
    ]);
    expect(stopped(d)).toEqual([{ reason: 'drained' }]);
    expect(stopped(empty)).toEqual([{ reason: 'drained' }]);
  });

  it('a backlog larger than the budget logs stopReason budget at warn and counts it', async () => {
    const d = deps({ expiryBatch: 2, expiryDailyRowBudget: 5 });
    const log = recordLog(d);
    await expired(12);
    await expect(expire(d)).resolves.toBe(5);
    expect(runComplete(log)).toEqual([
      { level: 'warn', obj: { archived: 5, stopReason: 'budget' }, msg: 'expiry run complete' },
    ]);
    expect(stopped(d)).toEqual([{ reason: 'budget' }]);
  });

  it('the lock step selects candidates by primary key (FORCE INDEX PRIMARY), even when the backlog is the batch', async () => {
    const rows = await expired(3);
    const { sql, bindings } = expiryLockStep(
      db as unknown as Knex.Transaction,
      rows.map((r) => r.id),
      new Date('2026-09-01T00:00:00Z'),
    ).toSQL();
    expect(sql).toMatch(/force index \(primary\)/i);
    expect(sql).toMatch(/for update skip locked/i);
    const [plan] = await db.raw(`EXPLAIN FORMAT=JSON ${sql}`, bindings as Knex.RawBinding[]);
    const json = JSON.stringify(JSON.parse(plan[0].EXPLAIN));
    expect(json).toContain('"key":"PRIMARY"');
    expect(json).not.toContain('skip_scan');
  });

  it('an archive row with the same id and different content fails the run and keeps both rows', async () => {
    const [row] = await expired(1);
    const stale = {
      ...Object.fromEntries(COLUMNS.map((c) => [c, (row as unknown as Record<string, unknown>)[c]])),
      public_id: 'dl_StaleStaleSt',
      dedupe_key: 'stale',
      archived_at: new Date('2026-01-01T00:00:00Z'),
    };
    await db('archived_notification_deliveries').insert(stale);
    const before = await db('archived_notification_deliveries').where('id', row!.id);
    const d = deps();
    await expect(expire(d)).rejects.toThrow(/Duplicate entry/);
    expect(await hotIds()).toEqual([row!.id]);
    expect(await db('archived_notification_deliveries').where('id', row!.id)).toEqual(before);
    expect(archivedCount(d)).toBe(0);
  });

  it('archive bytes equal the originals compared in SQL, including NULL and 4-byte UTF-8 keys', async () => {
    const n = await makeNotification(db, 'event');
    const ids: number[] = [];
    for (const [i, occurrence_key] of [null, 'Ünïcode 😀 key', 'trailing '].entries()) {
      ids.push(
        (
          await makeDelivery(db, {
            notification_id: n.id,
            account_id: i + 1,
            sent_at: new Date('2026-08-20T10:11:12Z'),
            occurrence_key,
            dedupe_key: `Dedupe 😀 ${i} `,
          })
        ).id,
      );
    }
    const [before] = await db.raw(`SELECT ${HEX_COLUMNS} FROM notification_deliveries ORDER BY id`);
    await expire(deps());
    const [after] = await db.raw(`SELECT ${HEX_COLUMNS} FROM archived_notification_deliveries ORDER BY id`);
    expect(after).toEqual(before);
    expect(after.map((r: { id: number }) => r.id)).toEqual(ids);
    const [[{ nullKeys }]] = await db.raw(
      `SELECT COUNT(*) AS nullKeys FROM archived_notification_deliveries WHERE id = ? AND occurrence_key <=> NULL`,
      [ids[0]!],
    );
    expect(Number(nullKeys)).toBe(1);
  });

  it('month boundary: 23:59:59 on the last day keeps a mid-previous-month row, midnight archives it', async () => {
    const n = await makeNotification(db, 'event');
    const row = await makeDelivery(db, {
      notification_id: n.id,
      account_id: 1,
      sent_at: new Date('2026-08-15T00:00:00Z'),
    });
    await expect(expire(deps({ now: new Date('2026-09-30T23:59:59Z') }))).resolves.toBe(0);
    expect(await hotIds()).toEqual([row.id]);
    await expect(expire(deps({ now: new Date('2026-10-01T00:00:00Z') }))).resolves.toBe(1);
    expect(await archivedIds()).toEqual([row.id]);
  });

  it('keeps the notifications of archived deliveries, including removed and inactive ones', async () => {
    const live = await makeNotification(db, 'event');
    const removed = await makeNotification(db, 'event', { removed: true });
    const inactive = await makeNotification(db, 'filter', { active: false });
    const sent_at = new Date('2026-08-10T00:00:00Z');
    for (const x of [live, removed, inactive])
      await makeDelivery(db, { notification_id: x.id, account_id: 1, sent_at });
    await expect(expire(deps())).resolves.toBe(3);
    const ids = [live.id, removed.id, inactive.id].sort((a, b) => a - b);
    expect(await db('notifications').whereIn('id', ids).orderBy('id').pluck('id')).toEqual(ids);
  });

  it('archived_at is the clock truncated to the whole second', async () => {
    await expired(1);
    await expire(deps({ now: new Date('2026-10-01T00:00:00.789Z') }));
    const [[{ at }]] = await db.raw(
      `SELECT CAST(archived_at AS CHAR) AS at FROM archived_notification_deliveries`,
    );
    expect(at).toBe('2026-10-01 00:00:00');
  });

  it('timer definition: leader-only, due at 01:00 UTC with the default config', () => {
    const t = expiryTimer(makeTestDeps({ db }));
    expect(t.name).toBe('expiry');
    expect(t.leaderOnly).toBe(true);
    expect(t.schedule.isDue(new Date('2026-10-06T01:00:00Z'), undefined)).toBe(true);
    expect(t.schedule.isDue(new Date('2026-10-06T02:00:00Z'), undefined)).toBe(false);
  });
});
