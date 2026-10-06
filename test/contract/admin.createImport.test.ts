/** Contract: POST /admin/notifications/imports (§3.4, §7.3, §9.4). */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApp } from '../helpers/app.js';
import { testDb, testConfig, resetDb } from '../helpers/db.js';
import type { FakeQueue } from '../helpers/fakeQueue.js';
import { loadConfig } from '../../src/config/index.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const future = () => new Date(Date.now() + 86_400_000).toISOString();
const content = { image: '/img/a.png', headline: 'Fall picks', subheadline: 'New', link: '/books/fall' };
const csv = 'accountID\n1\n2\n2\n999999\n';

type Parts = { notification?: unknown; file?: string | Buffer; extra?: boolean; rawJson?: string };
const post = (t: ReturnType<typeof testApp>, p: Parts, key: string | null = randomUUID(), acct = '1') => {
  let r = t.request.post('/admin/notifications/imports').set('X-Account-Id', acct);
  if (key !== null) r = r.set('Idempotency-Key', key);
  if (p.rawJson !== undefined) r = r.field('notification', p.rawJson);
  else if (p.notification !== undefined) r = r.field('notification', JSON.stringify(p.notification));
  if (p.file !== undefined) r = r.attach('file', Buffer.from(p.file), 'ids.csv');
  if (p.extra) r = r.field('other', 'x');
  return r;
};
const valid = (): Parts => ({ notification: { ...content, liveDate: future() }, file: csv });

const counts = async () => {
  const out: Record<string, number> = {};
  for (const tbl of ['notifications', 'imports', 'import_runs', 'import_files', 'import_row_errors']) {
    out[tbl] = Number((await db(tbl).count({ n: '*' }))[0]!.n);
  }
  return out;
};
const empty = { notifications: 0, imports: 0, import_runs: 0, import_files: 0, import_row_errors: 0 };

describe('POST /admin/notifications/imports', () => {
  it('202: creates the notification, import, run 1 and file, and enqueues one job', async () => {
    const t = testApp({ db });
    const liveDate = '2030-01-02T03:04:05Z';
    const res = await post(t, { notification: { ...content, liveDate }, file: csv });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: expect.any(Number), notificationId: expect.any(Number) });
    const n = await db('notifications').where({ id: res.body.notificationId }).first();
    expect(n.active).toBe(1);
    const [[stored]] = await db.raw('SELECT CAST(live_date AS CHAR) AS s FROM notifications WHERE id = ?', [
      n.id,
    ]);
    expect(stored.s).toBe('2030-01-02 03:04:05');
    const imp = await db('imports').where({ id: res.body.id }).first();
    expect(imp).toMatchObject({
      notification_id: res.body.notificationId,
      status: 'processing',
      total_rows: 4,
    });
    expect(imp.request_hash).toMatch(/^[0-9a-f]{64}$/);
    const runs = await db('import_runs').where({ import_id: res.body.id });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('processing');
    const file = await db('import_files').where({ import_id: res.body.id }).first();
    expect(Buffer.from(file.data).toString()).toBe(csv);
    const q = t.deps.queue as FakeQueue;
    expect(q.enqueued).toEqual([
      {
        type: 'process_import',
        payload: { importId: res.body.id, runId: runs[0].id, requestId: expect.any(String) },
      },
    ]);
  });

  it('a replay returns the same ids and creates and enqueues nothing', async () => {
    const t = testApp({ db });
    const key = randomUUID();
    const p = valid();
    const a = await post(t, p, key);
    const before = await counts();
    const b = await post(t, p, key);
    expect(b.status).toBe(202);
    expect(b.body).toEqual(a.body);
    expect(await counts()).toEqual(before);
    expect((t.deps.queue as FakeQueue).enqueued).toHaveLength(1);
  });

  it('400 when the key was used with a different body, or by a filter create', async () => {
    const t = testApp({ db });
    const key = randomUUID();
    await post(t, valid(), key);
    const before = await counts();
    const res = await post(t, { ...valid(), file: 'accountID\n7\n' }, key);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Idempotency-Key already used for a different request');
    expect(await counts()).toEqual(before);

    const key2 = randomUUID();
    const f = await t.request
      .post('/admin/notifications/filter')
      .set('X-Account-Id', '1')
      .set('Idempotency-Key', key2)
      .send({ ...content, isActive: false });
    expect(f.status).toBe(201);
    const before2 = await counts();
    expect((await post(t, valid(), key2)).status).toBe(400);
    expect(await counts()).toEqual(before2);
  });

  const small = { ...testConfig(), csvMaxRows: 2, csvMaxBytes: 40 };
  const bad: Array<[string, Parts, string | undefined]> = [
    ['wrong header', { ...valid(), file: 'accountId\n1\n' }, undefined],
    ['non-integer row', { ...valid(), file: 'accountID\n1\nabc\n' }, undefined],
    ['empty file', { ...valid(), file: '' }, undefined],
    ['over the byte cap', { ...valid(), file: 'accountID\n1\n' + '\n'.repeat(40) }, undefined],
    ['over the row cap', { ...valid(), file: 'accountID\n1\n2\n3\n' }, undefined],
    ['missing file part', { notification: valid().notification }, undefined],
    ['missing notification part', { file: csv }, undefined],
    ['an extra part', { ...valid(), extra: true }, undefined],
    ['malformed JSON part', { rawJson: '{"image":', file: csv }, undefined],
    [
      'unknown key in JSON part',
      { notification: { ...content, liveDate: future(), x: 1 }, file: csv },
      undefined,
    ],
    [
      'bad content field',
      { notification: { ...content, link: 'nope', liveDate: future() }, file: csv },
      undefined,
    ],
    ['bad liveDate', { notification: { ...content, liveDate: 'tomorrow' }, file: csv }, undefined],
    [
      'liveDate in the past',
      { notification: { ...content, liveDate: '2001-01-01T00:00:00Z' }, file: csv },
      'liveDate must be in the future',
    ],
  ];
  it.each(bad)('400 for %s, nothing persisted', async (_name, p, message) => {
    const t = testApp({ db, config: small });
    const res = await post(t, p);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    if (message) expect(res.body.message).toBe(message);
    expect(await counts()).toEqual(empty);
    expect((t.deps.queue as FakeQueue).enqueued).toHaveLength(0);
  });

  it('400 for a liveDate exactly now', async () => {
    const t = testApp({ db });
    const now = new Date(Math.floor(t.clock.now().getTime() / 1000) * 1000).toISOString();
    const res = await post(t, { notification: { ...content, liveDate: now }, file: csv });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'VALIDATION_ERROR', message: 'liveDate must be in the future' });
    expect(await counts()).toEqual(empty);
  });

  it('400 for a missing or invalid Idempotency-Key, nothing persisted', async () => {
    const t = testApp({ db });
    expect((await post(t, valid(), null)).status).toBe(400);
    expect((await post(t, valid(), 'not-a-uuid')).status).toBe(400);
    expect(await counts()).toEqual(empty);
  });

  it('202 even when the enqueue fails', async () => {
    const t = testApp({ db });
    (t.deps.queue as FakeQueue).failNextEnqueue(new Error('down'));
    const res = await post(t, valid());
    expect(res.status).toBe(202);
    expect((await counts()).imports).toBe(1);
  });

  it('401 and 403, nothing persisted and nothing enqueued', async () => {
    const t = testApp({ db });
    expect((await t.request.post('/admin/notifications/imports').field('x', 'y')).status).toBe(401);
    expect((await post(t, valid(), randomUUID(), '4')).status).toBe(403);
    expect(await counts()).toEqual(empty);
    expect((t.deps.queue as FakeQueue).enqueued).toHaveLength(0);
  });

  it('default caps: 10 MiB and 1,000,000 rows', () => {
    const c = loadConfig({ ...process.env, CSV_MAX_BYTES: undefined, CSV_MAX_ROWS: undefined });
    expect(c.csvMaxBytes).toBe(10485760);
    expect(c.csvMaxRows).toBe(1000000);
  });

  it('at the default 10 MiB cap: 10 MiB + 1 byte is 400 with nothing persisted; a 1 MiB valid file is 202', async () => {
    const config = loadConfig({
      ASSET_BASE_URL: 'https://assets.example.com',
      SITE_BASE_URL: 'https://www.example.com',
      DATABASE_URL: 'mysql://root:root@127.0.0.1:3306/notification_center',
      ...process.env,
      STANDINS: 'true',
      CSV_MAX_BYTES: undefined,
      CSV_MAX_ROWS: undefined,
    });
    expect(config.csvMaxBytes).toBe(10485760);
    const t = testApp({ db, config });
    const head = 'accountID\n1\n';
    const over = Buffer.alloc(10485761, '\n');
    over.write(head);
    expect(over.length).toBe(10485761);
    const res = await post(t, { ...valid(), file: over });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(await counts()).toEqual(empty);
    expect((t.deps.queue as FakeQueue).enqueued).toHaveLength(0);

    const rows = 524283; // 'accountID\n' + rows * '1\n' = 1 MiB
    const mib = 'accountID\n' + '1\n'.repeat(rows);
    expect(Buffer.byteLength(mib)).toBe(1048576);
    const ok = await post(t, { ...valid(), file: mib });
    expect(ok.status).toBe(202);
    expect((await db('imports').where({ id: ok.body.id }).first('total_rows')).total_rows).toBe(rows);
    expect((t.deps.queue as FakeQueue).enqueued).toHaveLength(1);
  });

  it('400, nothing persisted, for a liveDate beyond the DATETIME range in UTC', async () => {
    const t = testApp({ db });
    const res = await post(t, {
      notification: { ...content, liveDate: '9999-12-31T23:59:59-05:00' },
      file: csv,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(await counts()).toEqual(empty);
    expect((t.deps.queue as FakeQueue).enqueued).toHaveLength(0);
  });

  it.each(['createdFrom', 'createdTo'])('list %s in year 10000 (UTC) is 400, not 500', async (param) => {
    const t = testApp({ db });
    const res = await t.request
      .get('/admin/notifications')
      .query({ [param]: '9999-12-31T23:59:59-05:00' })
      .set('X-Account-Id', '1');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  describe('replay after liveDate has passed', () => {
    const near = (t: ReturnType<typeof testApp>) => ({
      notification: { ...content, liveDate: new Date(t.clock.now().getTime() + 60_000).toISOString() },
      file: csv,
    });
    it('same body: 202 with the same ids, nothing more created or enqueued', async () => {
      const t = testApp({ db });
      const key = randomUUID();
      const p = near(t);
      const a = await post(t, p, key);
      expect(a.status).toBe(202);
      t.clock.advance(120_000);
      const b = await post(t, p, key);
      expect(b.status).toBe(202);
      expect(b.body).toEqual(a.body);
      expect(await counts()).toMatchObject({ notifications: 1, imports: 1, import_runs: 1 });
      expect((t.deps.queue as FakeQueue).enqueued).toHaveLength(1);
    });
    it('different body: 400 key reuse, not the date message', async () => {
      const t = testApp({ db });
      const key = randomUUID();
      const p = near(t);
      await post(t, p, key);
      t.clock.advance(120_000);
      const res = await post(t, { ...p, file: 'accountID\n7\n' }, key);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Idempotency-Key already used for a different request');
    });
    it('first-time upload with a past liveDate is still 400 with the date message', async () => {
      const t = testApp({ db });
      const p = near(t);
      t.clock.advance(120_000);
      const res = await post(t, p);
      expect(res.body).toEqual({ error: 'VALIDATION_ERROR', message: 'liveDate must be in the future' });
    });
    it('replay after the byte cap was lowered: 202', async () => {
      const t = testApp({ db });
      const key = randomUUID();
      const p = valid();
      const a = await post(t, p, key);
      const t2 = testApp({ db, clock: t.clock, config: { ...testConfig(), csvMaxBytes: 10 } });
      const b = await post(t2, p, key);
      expect(b.status).toBe(202);
      expect(b.body).toEqual(a.body);
      expect((await counts()).imports).toBe(1);
    });
    it('replay after the row cap was lowered: 202', async () => {
      const t = testApp({ db });
      const key = randomUUID();
      const p = valid();
      const a = await post(t, p, key);
      const t2 = testApp({ db, clock: t.clock, config: { ...testConfig(), csvMaxRows: 1 } });
      const b = await post(t2, p, key);
      expect(b.status).toBe(202);
      expect(b.body).toEqual(a.body);
      expect((await counts()).imports).toBe(1);
      expect((t2.deps.queue as FakeQueue).enqueued).toHaveLength(0);
    });
  });
});
