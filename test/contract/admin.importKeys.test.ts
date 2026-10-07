/**
 * Contract: an Idempotency-Key identifies a request within one endpoint's table (§9.4), so a key already used by an
 * import upload or an import run is a new request for the filter/event creates.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApp } from '../helpers/app.js';
import { testDb, resetDb } from '../helpers/db.js';
import { onProcessImportDead } from '../../src/jobs/processImport.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const content = { image: '/img/a.png', headline: 'H', subheadline: 'S', link: '/x' };
type App = ReturnType<typeof testApp>;

async function upload(t: App, key: string) {
  const res = await t.request
    .post('/admin/notifications/imports')
    .set('X-Account-Id', '1')
    .set('Idempotency-Key', key)
    .field(
      'notification',
      JSON.stringify({ ...content, liveDate: new Date(Date.now() + 86_400_000).toISOString() }),
    )
    .attach('file', Buffer.from('accountID\n5\n'), 'ids.csv');
  expect(res.status).toBe(202);
  return res.body.id as number;
}
const countNotifications = async () => Number((await db('notifications').count({ n: '*' }))[0]!.n);

describe('Idempotency-Key scoped per table across import and notification creates', () => {
  it('an import upload key is a new request for the filter create', async () => {
    const t = testApp({ db });
    const key = randomUUID();
    await upload(t, key);
    const res = await t.request
      .post('/admin/notifications/filter')
      .set('X-Account-Id', '1')
      .set('Idempotency-Key', key)
      .send({ ...content, isActive: true });
    expect(res.status).toBe(201);
    expect(await db('notifications').where({ id: res.body.id }).first('request_key')).toEqual({
      request_key: key,
    });
    expect(await countNotifications()).toBe(2);
  });

  it('an import run key is a new request for the event create', async () => {
    const t = testApp({ db });
    const importId = await upload(t, randomUUID());
    const runId = (await db('import_runs').where({ import_id: importId }).first('id')).id;
    await onProcessImportDead(t.deps, { importId, runId, requestId: 'r' }, new Error('x'));
    const key = randomUUID();
    const run = await t.request
      .post(`/admin/notifications/imports/${importId}/runs`)
      .set('X-Account-Id', '1')
      .set('Idempotency-Key', key);
    expect(run.status).toBe(202);
    const res = await t.request
      .post('/admin/notifications/event')
      .set('X-Account-Id', '1')
      .set('Idempotency-Key', key)
      .send({ ...content, isActive: true, eventTrigger: 'shipped' });
    expect(res.status).toBe(201);
    expect(await db('notifications').where({ id: res.body.id }).first('request_key')).toEqual({
      request_key: key,
    });
    expect(await countNotifications()).toBe(2);
  });
});
