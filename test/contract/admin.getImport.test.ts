/** Contract: GET /admin/notifications/imports/:id (§3.4). */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import { processImport, onProcessImportDead } from '../../src/jobs/processImport.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const content = { image: '/img/a.png', headline: 'H', subheadline: 'S', link: '/x' };
const jobCtx = { heartbeat: async () => {} } as never;
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const file = 'accountID\n5\n7\n5\n900000\n8\n7\n900001\n';

async function upload(t: ReturnType<typeof testApp>, csv = file) {
  const res = await t.request
    .post('/admin/notifications/imports')
    .set('X-Account-Id', '1')
    .set('Idempotency-Key', randomUUID())
    .field(
      'notification',
      JSON.stringify({ ...content, liveDate: new Date(Date.now() + 86_400_000).toISOString() }),
    )
    .attach('file', Buffer.from(csv), 'ids.csv');
  expect(res.status).toBe(202);
  const runId = (await db('import_runs').where({ import_id: res.body.id }).first('id')).id as number;
  return { id: res.body.id as number, notificationId: res.body.notificationId as number, runId };
}
const get = (t: ReturnType<typeof testApp>, id: number | string, acct = '1') =>
  t.request.get(`/admin/notifications/imports/${id}`).set('X-Account-Id', acct);
const reconciles = (b: {
  totalRows: number;
  accepted: number;
  duplicatesIgnored: number;
  errors: unknown[];
}) => expect(b.totalRows).toBe(b.accepted + b.duplicatesIgnored + b.errors.length);

describe('GET /admin/notifications/imports/:id', () => {
  it('processing before the job: zero counters, one run, no errors, exact keys', async () => {
    const t = testApp({ db });
    const up = await upload(t);
    const res = await get(t, up.id);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'accepted',
        'duplicatesIgnored',
        'errors',
        'id',
        'notificationId',
        'runs',
        'status',
        'totalRows',
      ].sort(),
    );
    expect(res.body).toMatchObject({
      id: up.id,
      notificationId: up.notificationId,
      status: 'processing',
      totalRows: 7,
      accepted: 0,
      duplicatesIgnored: 0,
      errors: [],
    });
    expect(res.body.runs).toHaveLength(1);
    expect(Object.keys(res.body.runs[0]).sort()).toEqual([
      'error',
      'finishedAt',
      'id',
      'startedAt',
      'status',
    ]);
    expect(res.body.runs[0]).toMatchObject({
      id: up.runId,
      status: 'processing',
      finishedAt: null,
      error: null,
    });
    expect(res.body.runs[0].startedAt).toMatch(iso);
  });

  it('completed: counters, errors ordered by row, invariant holds, also after a second job run', async () => {
    const t = testApp({ db });
    const up = await upload(t);
    const payload = { importId: up.id, runId: up.runId, requestId: 'r' };
    await processImport(t.deps, payload, jobCtx);
    const res = await get(t, up.id);
    expect(res.body).toMatchObject({ status: 'completed', totalRows: 7, accepted: 3, duplicatesIgnored: 2 });
    expect(res.body.errors).toEqual([
      { row: 4, accountId: 900000, reason: 'UNKNOWN_ACCOUNT' },
      { row: 7, accountId: 900001, reason: 'UNKNOWN_ACCOUNT' },
    ]);
    expect(Object.keys(res.body.errors[0]).sort()).toEqual(['accountId', 'reason', 'row']);
    expect(res.body.runs[0].status).toBe('completed');
    expect(res.body.runs[0].finishedAt).toMatch(iso);
    reconciles(res.body);
    await processImport(t.deps, payload, jobCtx);
    const again = await get(t, up.id);
    expect(again.body).toEqual(res.body);
  });

  it('several thousand unknown ids: errors uncapped and the totals reconcile', async () => {
    const t = testApp({ db });
    const ids = Array.from({ length: 3000 }, (_, i) => 800000 + i);
    const up = await upload(t, `accountID\n5\n5\n${ids.join('\n')}\n`);
    await processImport(t.deps, { importId: up.id, runId: up.runId, requestId: 'r' }, jobCtx);
    const res = await get(t, up.id);
    expect(res.body).toMatchObject({ totalRows: 3002, accepted: 1, duplicatesIgnored: 1 });
    expect(res.body.errors).toHaveLength(3000);
    expect(res.body.errors[0]).toEqual({ row: 3, accountId: 800000, reason: 'UNKNOWN_ACCOUNT' });
    expect(res.body.errors[2999].row).toBe(3002);
    reconciles(res.body);
  });

  it('failed after the dead-letter hook; two runs are listed oldest first', async () => {
    const t = testApp({ db });
    const up = await upload(t);
    await onProcessImportDead(t.deps, { importId: up.id, runId: up.runId, requestId: 'r' }, new Error('x'));
    const res = await get(t, up.id);
    expect(res.body).toMatchObject({ status: 'failed', accepted: 0, duplicatesIgnored: 0, errors: [] });
    expect(res.body.runs[0]).toMatchObject({ id: up.runId, status: 'failed', error: expect.any(String) });
    expect(res.body.runs[0].finishedAt).toMatch(iso);
    const [second] = await db('import_runs').insert({
      import_id: up.id,
      status: 'processing',
      started_at: new Date(),
    });
    const two = await get(t, up.id);
    expect(two.body.runs.map((r: { id: number }) => r.id)).toEqual([up.runId, second]);
  });

  it('400 for a non-integer id, 404 when absent, and no collision with the notification routes', async () => {
    const t = testApp({ db });
    for (const bad of ['abc', '0', '-1', '1.5']) {
      const r = await get(t, bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('VALIDATION_ERROR');
    }
    const r404 = await get(t, 12345);
    expect(r404.status).toBe(404);
    expect(r404.body.error).toBe('NOT_FOUND');
    const bare = await t.request.get('/admin/notifications/imports').set('X-Account-Id', '1');
    expect(bare.status).toBeLessThan(500);
  });

  it('401 and 403', async () => {
    const t = testApp({ db });
    expect((await t.request.get('/admin/notifications/imports/1')).status).toBe(401);
    expect((await get(t, 1, '4')).status).toBe(403);
  });
});
