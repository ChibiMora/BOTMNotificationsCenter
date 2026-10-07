/** Contract: POST /admin/notifications/imports/:id/runs (§3.4, §7.3). */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import type { FakeQueue } from '../helpers/fakeQueue.js';
import { processImport, onProcessImportDead } from '../../src/jobs/processImport.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const content = { image: '/img/a.png', headline: 'H', subheadline: 'S', link: '/x' };
const jobCtx = { heartbeat: async () => {} } as never;
const DIFFERENT = 'Idempotency-Key already used for a different request';
type App = ReturnType<typeof testApp>;

async function upload(t: App, key = randomUUID()) {
  const res = await t.request
    .post('/admin/notifications/imports')
    .set('X-Account-Id', '1')
    .set('Idempotency-Key', key)
    .field(
      'notification',
      JSON.stringify({ ...content, liveDate: new Date(Date.now() + 86_400_000).toISOString() }),
    )
    .attach('file', Buffer.from('accountID\n5\n7\n5\n900000\n8\n'), 'ids.csv');
  expect(res.status).toBe(202);
  const runId = (await db('import_runs').where({ import_id: res.body.id }).first('id')).id as number;
  return { id: res.body.id as number, notificationId: res.body.notificationId as number, runId };
}
/** An uploaded import whose run 1 was dead-lettered. */
async function failedImport(t: App) {
  const up = await upload(t);
  await onProcessImportDead(t.deps, { importId: up.id, runId: up.runId, requestId: 'r' }, new Error('x'));
  return up;
}
const post = (t: App, id: number | string, key: string | null = randomUUID(), acct = '1') => {
  let r = t.request.post(`/admin/notifications/imports/${id}/runs`).set('X-Account-Id', acct);
  if (key !== null) r = r.set('Idempotency-Key', key);
  return r;
};
const runCount = async (importId: number) =>
  Number((await db('import_runs').where({ import_id: importId }).count({ n: '*' }))[0]!.n);
const q = (t: App) => t.deps.queue as FakeQueue;

describe('POST /admin/notifications/imports/:id/runs', () => {
  it('409 while processing and when completed', async () => {
    const t = testApp({ db });
    const up = await upload(t);
    const r1 = await post(t, up.id);
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('CONFLICT');
    await processImport(t.deps, { importId: up.id, runId: up.runId, requestId: 'r' }, jobCtx);
    expect((await post(t, up.id)).status).toBe(409);
    expect(await runCount(up.id)).toBe(1);
  });

  it('202 after a failed run: new run, import processing, exactly one job enqueued', async () => {
    const t = testApp({ db });
    const up = await failedImport(t);
    q(t).enqueued.length = 0;
    const key = randomUUID();
    const res = await post(t, up.id, key);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: expect.any(Number), importId: up.id, notificationId: up.notificationId });
    const run = await db('import_runs').where({ id: res.body.id }).first();
    expect(run).toMatchObject({
      import_id: up.id,
      status: 'processing',
      request_key: key,
      finished_at: null,
    });
    expect((await db('imports').where({ id: up.id }).first('status')).status).toBe('processing');
    expect(q(t).enqueued).toHaveLength(1);
    expect(q(t).enqueued[0]).toMatchObject({
      type: 'process_import',
      payload: { importId: up.id, runId: res.body.id },
    });
  });

  it('after the stored file was deleted (housekeeping): 202, then the job fails the run with a short error', async () => {
    const t = testApp({ db });
    const up = await failedImport(t);
    await db('import_files').where({ import_id: up.id }).delete();
    q(t).enqueued.length = 0;
    const res = await post(t, up.id);
    expect(res.status).toBe(202);
    expect(q(t).enqueued).toHaveLength(1);
    const payload = q(t).enqueued[0]!.payload as { importId: number; runId: number; requestId: string };
    await expect(processImport(t.deps, payload, jobCtx)).resolves.toBeUndefined();
    const run = await db('import_runs').where({ id: res.body.id }).first('status', 'error', 'finished_at');
    expect(run.status).toBe('failed');
    expect(run.error).toBe('import file missing');
    expect(run.finished_at).not.toBeNull();
    expect((await db('imports').where({ id: up.id }).first('status')).status).toBe('failed');
  });

  it('a replay returns the same run and creates and enqueues nothing', async () => {
    const t = testApp({ db });
    const up = await failedImport(t);
    const key = randomUUID();
    const first = await post(t, up.id, key);
    q(t).enqueued.length = 0;
    const again = await post(t, up.id, key);
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    expect(await runCount(up.id)).toBe(2);
    expect(q(t).enqueued).toHaveLength(0);
  });

  it('400 when the key was used on another import; a key used by an upload or a notification create is a new run', async () => {
    const t = testApp({ db });
    const a = await failedImport(t);
    const b = await failedImport(t);
    const key = randomUUID();
    expect((await post(t, a.id, key)).status).toBe(202);
    const other = await post(t, b.id, key);
    expect(other.status).toBe(400);
    expect(other.body).toEqual({ error: 'VALIDATION_ERROR', message: DIFFERENT });
    expect(await runCount(b.id)).toBe(1);
    const uploadKey = randomUUID();
    await upload(t, uploadKey);
    expect((await post(t, b.id, uploadKey)).status).toBe(202);
    expect(await runCount(b.id)).toBe(2);
    const c = await failedImport(t);
    const nKey = randomUUID();
    await db('notifications').where({ id: a.notificationId }).update({ request_key: nKey });
    expect((await post(t, c.id, nKey)).status).toBe(202);
    expect(await runCount(c.id)).toBe(2);
  });

  it('two concurrent requests with different keys: exactly one run is created, the other gets 409', async () => {
    const t = testApp({ db });
    const up = await failedImport(t);
    const statuses = (await Promise.all([post(t, up.id), post(t, up.id)])).map((r) => r.status).sort();
    expect(statuses).toEqual([202, 409]);
    expect(await runCount(up.id)).toBe(2);
  });

  it('202 even when the enqueue fails', async () => {
    const t = testApp({ db });
    const up = await failedImport(t);
    q(t).failNextEnqueue(new Error('down'));
    expect((await post(t, up.id)).status).toBe(202);
  });

  it('400 missing/invalid key and non-integer id; 404; 401; 403', async () => {
    const t = testApp({ db });
    const up = await failedImport(t);
    expect((await post(t, up.id, null)).status).toBe(400);
    expect((await post(t, up.id, 'not-a-uuid')).status).toBe(400);
    expect((await post(t, 'abc')).status).toBe(400);
    const nf = await post(t, 99999);
    expect(nf.status).toBe(404);
    expect(nf.body.error).toBe('NOT_FOUND');
    expect((await t.request.post(`/admin/notifications/imports/${up.id}/runs`)).status).toBe(401);
    expect((await post(t, up.id, randomUUID(), '4')).status).toBe(403);
    expect(await runCount(up.id)).toBe(1);
  });

  it('end to end: upload, dead-letter, failed report, new run, job, completed and reconciled', async () => {
    const t = testApp({ db });
    const up = await upload(t);
    // Run 1 never completes; the queue gives up on it (the file is kept for the retry).
    await onProcessImportDead(t.deps, { importId: up.id, runId: up.runId, requestId: 'r' }, new Error('x'));
    const failed = await t.request.get(`/admin/notifications/imports/${up.id}`).set('X-Account-Id', '1');
    expect(failed.body.status).toBe('failed');
    const res = await post(t, up.id);
    expect(res.status).toBe(202);
    await processImport(t.deps, { importId: up.id, runId: res.body.id, requestId: 'r' }, jobCtx);
    await processImport(t.deps, { importId: up.id, runId: res.body.id, requestId: 'r' }, jobCtx);
    const done = await t.request.get(`/admin/notifications/imports/${up.id}`).set('X-Account-Id', '1');
    expect(done.body).toMatchObject({ status: 'completed', totalRows: 5, accepted: 3, duplicatesIgnored: 1 });
    expect(done.body.errors).toEqual([{ row: 4, accountId: 900000, reason: 'UNKNOWN_ACCOUNT' }]);
    expect(done.body.runs.map((r: { status: string }) => r.status)).toEqual(['failed', 'completed']);
    const dup = await db('notification_deliveries')
      .where({ notification_id: up.notificationId })
      .groupBy('account_id')
      .havingRaw('COUNT(*) > 1')
      .select('account_id');
    expect(dup).toEqual([]);
    expect(
      Number(
        (
          await db('notification_deliveries').where({ notification_id: up.notificationId }).count({ n: '*' })
        )[0]!.n,
      ),
    ).toBe(3);
  });
});
