/** Integration: process_import against real MySQL (§7.3 steps 5–9, §8.2). */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { RecordingMetrics } from '../helpers/deps.js';
import { randomUUID } from 'node:crypto';
import { testApp } from '../helpers/app.js';
import { testDb, testConfig, resetDb } from '../helpers/db.js';
import { processImport, onProcessImportDead } from '../../src/jobs/processImport.js';
import { dueSendTimer } from '../../src/scheduler/dueSend.js';
import { FixedClock } from '../helpers/clock.js';
import { ACCOUNTS_TABLE, ACCOUNT_COLUMNS } from '../../src/eligibility/accountsSchema.js';
import type { Knex } from 'knex';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const content = { image: '/img/a.png', headline: 'H', subheadline: 'S', link: '/x' };
const ctx = { heartbeat: async () => {} } as never;

/** Uploads through the API; returns the app and the enqueued payload. */
async function upload(
  file: string,
  liveDate = new Date(Date.now() + 86_400_000).toISOString(),
  chunk = 2,
  appDb: Knex = db,
) {
  const t = testApp({ db: appDb, clock: new FixedClock(), config: { ...testConfig(), importChunk: chunk } });
  const res = await t.request
    .post('/admin/notifications/imports')
    .set('X-Account-Id', '1')
    .set('Idempotency-Key', randomUUID())
    .field('notification', JSON.stringify({ ...content, liveDate }))
    .attach('file', Buffer.from(file), 'ids.csv');
  expect(res.status).toBe(202);
  const payload = { importId: res.body.id, runId: 0, requestId: 'r' };
  payload.runId = (await db('import_runs').where({ import_id: res.body.id }).first('id')).id;
  return { t, payload, notificationId: res.body.notificationId as number };
}
const report = async (importId: number) => ({
  imp: await db('imports')
    .where({ id: importId })
    .first('status', 'accepted', 'duplicates_ignored', 'total_rows'),
  errors: await db('import_row_errors')
    .where({ import_id: importId })
    .orderBy('row_num')
    .select('row_num', 'account_id'),
  deliveries: await db('notification_deliveries').orderBy('account_id').pluck('account_id'),
  file: await db('import_files').where({ import_id: importId }).first('import_id'),
});
const file = 'accountID\n5\n7\n5\n900000\n8\n7\n900001\n';

describe('process_import', () => {
  it('reports duplicates and unknown ids, deletes the file, and is idempotent when run twice', async () => {
    const { t, payload } = await upload(file);
    await processImport(t.deps, payload, ctx);
    const first = await report(payload.importId);
    expect(first.imp).toEqual({ status: 'completed', accepted: 3, duplicates_ignored: 2, total_rows: 7 });
    expect(first.errors).toEqual([
      { row_num: 4, account_id: 900000 },
      { row_num: 7, account_id: 900001 },
    ]);
    expect(first.deliveries).toEqual([5, 7, 8]);
    expect(first.file).toBeUndefined();
    await processImport(t.deps, payload, ctx);
    expect(await report(payload.importId)).toEqual(first);
  });

  it('future liveDate: deliveries are scheduled (sent_at NULL)', async () => {
    const { t, payload } = await upload(file);
    await processImport(t.deps, payload, ctx);
    expect(await db('notification_deliveries').whereNotNull('sent_at').count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('removed before the job: run failed and file deleted, no deliveries', async () => {
    const { t, payload, notificationId } = await upload(file);
    await db('notifications').where({ id: notificationId }).update({ removed: true });
    await processImport(t.deps, payload, ctx);
    const r = await report(payload.importId);
    expect(r.imp.status).toBe('failed');
    expect(r.file).toBeUndefined();
    expect(r.deliveries).toEqual([]);
    expect((await db('import_runs').where({ id: payload.runId }).first()).status).toBe('failed');
  });

  it('a chunk that throws, then a retry, completes with correct totals; updated_at is touched per chunk', async () => {
    const { t, payload } = await upload(file);
    let beats = 0;
    const failing = {
      heartbeat: async () => {
        beats += 1;
        if (beats === 1) throw new Error('lease lost');
      },
    } as never;
    await expect(processImport(t.deps, payload, failing)).rejects.toThrow('lease lost');
    await processImport(t.deps, payload, ctx);
    expect((await report(payload.importId)).imp).toMatchObject({ status: 'completed', accepted: 3 });
  });

  it('dead-letter: run and import failed, file and deliveries kept', async () => {
    const { t, payload } = await upload(file);
    await onProcessImportDead(t.deps, payload, new Error('boom'));
    const r = await report(payload.importId);
    expect(r.imp.status).toBe('failed');
    expect(r.file).toBeDefined();
    const run = await db('import_runs').where({ id: payload.runId }).first();
    expect(run.status).toBe('failed');
    expect(run.error).toEqual(expect.any(String));
    expect(run.finished_at).not.toBeNull();
  });

  const LIVE = '2026-10-05T00:00:00.000Z';
  const deliveryRows = () =>
    db('notification_deliveries').orderBy('account_id').select('account_id', 'sent_at', 'due_at');
  const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());
  const rowsAsIso = async () =>
    (await deliveryRows()).map((r) => ({
      account_id: r.account_id,
      sent_at: iso(r.sent_at),
      due_at: iso(r.due_at),
    }));
  const reconciles = (r: Awaited<ReturnType<typeof report>>) =>
    expect(r.imp.accepted + r.imp.duplicates_ignored + r.errors.length).toBe(r.imp.total_rows);

  it('live_date already due at processing time: every accepted delivery is live at once', async () => {
    const { t, payload } = await upload('accountID\n3\n9001\n4\n', LIVE);
    t.clock.set('2026-10-05T01:00:00Z');
    await processImport(t.deps, payload, ctx);
    expect(await rowsAsIso()).toEqual([
      { account_id: 3, sent_at: '2026-10-05T01:00:00.000Z', due_at: LIVE },
      { account_id: 4, sent_at: '2026-10-05T01:00:00.000Z', due_at: LIVE },
    ]);
  });

  it('future liveDate: scheduled, then released by due-send with sent_at = the release time', async () => {
    const { t, payload } = await upload('accountID\n3\n4\n', LIVE);
    await processImport(t.deps, payload, ctx);
    expect((await rowsAsIso()).map((r) => r.sent_at)).toEqual([null, null]);
    t.clock.set('2026-10-05T00:05:00Z');
    await dueSendTimer(t.deps).run(t.deps);
    expect(await rowsAsIso()).toEqual([
      { account_id: 3, sent_at: '2026-10-05T00:05:00.000Z', due_at: LIVE },
      { account_id: 4, sent_at: '2026-10-05T00:05:00.000Z', due_at: LIVE },
    ]);
  });

  it('removed after the job, before liveDate: due-send deletes the rows, none was ever live', async () => {
    const { t, payload, notificationId } = await upload('accountID\n3\n4\n', LIVE);
    await processImport(t.deps, payload, ctx);
    expect(await db('notification_deliveries').whereNotNull('sent_at').count({ n: '*' })).toEqual([{ n: 0 }]);
    t.clock.set('2026-10-04T18:00:00Z');
    await db('notifications')
      .where({ id: notificationId })
      .update({ removed: true, active: false, cancelled_before: new Date('2026-10-04T18:00:00Z') });
    t.clock.set('2026-10-05T00:05:00Z');
    await dueSendTimer(t.deps).run(t.deps);
    expect(await deliveryRows()).toEqual([]);
  });

  it('two concurrent runs: no duplicates, one consistent report, completed, file gone', async () => {
    const { t, payload } = await upload(file, LIVE);
    await expect(
      Promise.all([processImport(t.deps, payload, ctx), processImport(t.deps, payload, ctx)]),
    ).resolves.toBeDefined();
    const r = await report(payload.importId);
    expect(r.imp).toEqual({ status: 'completed', accepted: 3, duplicates_ignored: 2, total_rows: 7 });
    expect(r.errors).toEqual([
      { row_num: 4, account_id: 900000 },
      { row_num: 7, account_id: 900001 },
    ]);
    expect(r.deliveries).toEqual([5, 7, 8]);
    expect(r.file).toBeUndefined();
    expect((await db('import_runs').where({ id: payload.runId }).first()).status).toBe('completed');
  });

  it('imports.updated_at advances after each chunk', async () => {
    const { t, payload } = await upload('accountID\n1\n2\n3\n4\n5\n', LIVE, 2);
    const seen: number[] = [];
    const hb = {
      heartbeat: async () => {
        seen.push(
          new Date(
            (await db('imports').where({ id: payload.importId }).first('updated_at')).updated_at,
          ).getTime(),
        );
        t.clock.advance(1000);
      },
    } as never;
    await processImport(t.deps, payload, hb);
    expect(seen).toHaveLength(3);
    expect(seen[1]!).toBeGreaterThan(seen[0]!);
    expect(seen[2]!).toBeGreaterThan(seen[1]!);
  });

  it('removed between chunks: failed, file deleted, no further chunk, first chunk kept', async () => {
    const { t, payload, notificationId } = await upload('accountID\n1\n2\n3\n4\n5\n', LIVE, 2);
    const hb = {
      heartbeat: async () => {
        await db('notifications')
          .where({ id: notificationId })
          .update({ removed: true, active: false, cancelled_before: t.clock.now() });
      },
    } as never;
    await processImport(t.deps, payload, hb);
    const r = await report(payload.importId);
    expect(r.imp.status).toBe('failed');
    expect(r.file).toBeUndefined();
    expect(r.deliveries).toEqual([1, 2]);
    const run = await db('import_runs').where({ id: payload.runId }).first();
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^.{1,255}$/);
  });

  it('every id unknown: completed, accepted 0, one error per distinct id at its first row', async () => {
    const { t, payload } = await upload('accountID\n9001\n9002\n9001\n9003\n', LIVE);
    await processImport(t.deps, payload, ctx);
    const r = await report(payload.importId);
    expect(r.imp).toEqual({ status: 'completed', accepted: 0, duplicates_ignored: 1, total_rows: 4 });
    expect(r.errors).toEqual([
      { row_num: 1, account_id: 9001 },
      { row_num: 2, account_id: 9002 },
      { row_num: 4, account_id: 9003 },
    ]);
    expect(r.deliveries).toEqual([]);
    reconciles(r);
  });

  it('an account deleted between the existence lookup and the insert is reported UNKNOWN_ACCOUNT', async () => {
    // A db whose accounts lookup deletes account 4 right after it has been found.
    const racing = new Proxy(db, {
      apply(target, self, args: [string]) {
        const qb = Reflect.apply(target, self, args) as Knex.QueryBuilder;
        if (args[0] === ACCOUNTS_TABLE) {
          const pluck = qb.pluck.bind(qb);
          (qb as { pluck: unknown }).pluck = (col: string) =>
            pluck(col).then(async (ids: unknown) => {
              await db(ACCOUNTS_TABLE).where(ACCOUNT_COLUMNS.id, 4).delete();
              return ids;
            });
        }
        return qb;
      },
    });
    const { t, payload } = await upload('accountID\n3\n4\n3\n', LIVE, 10, racing);
    await processImport(t.deps, payload, ctx);
    const r = await report(payload.importId);
    expect(r.imp).toEqual({ status: 'completed', accepted: 1, duplicates_ignored: 1, total_rows: 3 });
    expect(
      await db('import_row_errors')
        .where({ import_id: payload.importId })
        .select('row_num', 'account_id', 'reason'),
    ).toEqual([{ row_num: 2, account_id: 4, reason: 'UNKNOWN_ACCOUNT' }]);
    expect(r.deliveries).toEqual([3]);
    reconciles(r);
  });

  it('awkward line endings: the job sees exactly the rows the upload counted', async () => {
    for (const f of [
      'accountID\r3\r4\r9001\r3\r',
      '﻿accountID\r\n3\r\n\r\n4\r\n9001\r\n\r\n',
      'accountID\n3\n\n4\n9001\n3',
    ]) {
      await resetDb(db);
      const { t, payload } = await upload(f, LIVE);
      await processImport(t.deps, payload, ctx);
      const r = await report(payload.importId);
      expect(r.imp.status).toBe('completed');
      expect(r.deliveries).toEqual([3, 4]);
      expect(r.errors).toEqual([{ row_num: 3, account_id: 9001 }]);
      reconciles(r);
    }
  });

  describe('logs and metrics', () => {
    const counted = (t: { deps: { metrics: unknown } }) =>
      (t.deps.metrics as RecordingMetrics).calls
        .filter((c) => c.kind === 'count' && c.name.startsWith('process_import_'))
        .map(({ name, value, dims }) => ({ name, value, ...(dims ? { dims } : {}) }));

    it('a completed run logs once at info with ids and counts, and counts its metrics', async () => {
      const { t, payload } = await upload(file);
      const info = vi.spyOn(t.deps.log, 'info');
      await processImport(t.deps, payload, ctx);
      const calls = info.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].startsWith('process_import'),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toEqual({
        importId: payload.importId,
        runId: payload.runId,
        accepted: 3,
        duplicatesIgnored: 2,
        errors: 2,
        deliveriesInserted: 3,
      });
      expect(counted(t)).toEqual([
        { name: 'process_import_deliveries_written', value: 3 },
        { name: 'process_import_unknown_accounts', value: 2 },
        { name: 'process_import_completed', value: 1 },
      ]);
      await processImport(t.deps, payload, ctx);
      expect(counted(t)).toHaveLength(3);
    });

    const warned = (t: { deps: { log: unknown } }) => {
      const warn = vi.spyOn((t.deps as { log: { warn: (...a: unknown[]) => void } }).log, 'warn');
      return () =>
        warn.mock.calls.filter((c) => typeof c[1] === 'string' && c[1].startsWith('process_import'));
    };
    const runStatus = async (runId: number) =>
      (await db('import_runs').where({ id: runId }).first('status')).status as string;

    it('removed notification counts process_import_failed reason=removed once and logs once at warn', async () => {
      const { t, payload, notificationId } = await upload(file);
      const warns = warned(t);
      await db('notifications').where({ id: notificationId }).update({ removed: true });
      await processImport(t.deps, payload, ctx);
      expect(counted(t)).toEqual([{ name: 'process_import_failed', value: 1, dims: { reason: 'removed' } }]);
      expect(warns()).toHaveLength(1);
      expect(warns()[0]![0]).toEqual({ importId: payload.importId, runId: payload.runId, reason: 'removed' });
    });

    it('removed while a concurrent copy already finished the run: no failed metric, no warn', async () => {
      const { t, payload, notificationId } = await upload(file);
      const warns = warned(t);
      // After the first chunk, the notification is removed and a concurrent copy finishes the run.
      const concurrent = {
        heartbeat: async () => {
          await db('notifications').where({ id: notificationId }).update({ removed: true });
          await db('import_runs').where({ id: payload.runId }).update({ status: 'completed' });
        },
      } as never;
      await processImport(t.deps, payload, concurrent);
      expect(await runStatus(payload.runId)).toBe('completed');
      expect(counted(t)).toEqual([]);
      expect(warns()).toHaveLength(0);
    });

    it('import file missing: run failed, counts failed reason=file_missing once, logs once at warn', async () => {
      const { t, payload } = await upload(file);
      const warns = warned(t);
      await db('import_files').where({ import_id: payload.importId }).delete();
      await processImport(t.deps, payload, ctx);
      expect(await runStatus(payload.runId)).toBe('failed');
      expect((await db('imports').where({ id: payload.importId }).first('status')).status).toBe('failed');
      expect(counted(t)).toEqual([
        { name: 'process_import_failed', value: 1, dims: { reason: 'file_missing' } },
      ]);
      expect(warns()).toHaveLength(1);
      expect(warns()[0]![0]).toEqual({
        importId: payload.importId,
        runId: payload.runId,
        reason: 'file_missing',
      });
    });

    it('dead-letter on a processing run counts failed reason=dead exactly once and logs once at warn', async () => {
      const { t, payload } = await upload(file);
      const warns = warned(t);
      await onProcessImportDead(t.deps, payload, new Error('boom'));
      expect(await runStatus(payload.runId)).toBe('failed');
      expect(counted(t)).toEqual([{ name: 'process_import_failed', value: 1, dims: { reason: 'dead' } }]);
      expect(warns()).toHaveLength(1);
      expect(warns()[0]![0]).toEqual({ importId: payload.importId, runId: payload.runId, reason: 'dead' });
      await onProcessImportDead(t.deps, payload, new Error('boom'));
      expect(counted(t)).toHaveLength(1);
      expect(warns()).toHaveLength(1);
    });

    it('dead-letter on a completed run: run stays completed, no failed metric, no warn', async () => {
      const { t, payload } = await upload(file);
      await processImport(t.deps, payload, ctx);
      const before = counted(t).length;
      const warns = warned(t);
      await onProcessImportDead(t.deps, payload, new Error('boom'));
      expect(await runStatus(payload.runId)).toBe('completed');
      expect((await db('imports').where({ id: payload.importId }).first('status')).status).toBe('completed');
      expect(counted(t).slice(before)).toEqual([]);
      expect(warns()).toHaveLength(0);
    });
  });
});
