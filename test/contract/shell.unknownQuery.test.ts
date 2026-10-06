/** Contract: every admin and member route rejects unknown query-string keys like the list endpoints do (§3.2). */
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApp } from '../helpers/app.js';
import { testDb } from '../helpers/db.js';

const db = testDb();
afterAll(() => db.destroy());

const EXPECTED = { error: 'VALIDATION_ERROR', message: "Unrecognized key(s) in object: 'foo'" };

type Call = (t: ReturnType<typeof testApp>) => PromiseLike<{ status: number; body: unknown }>;
const admin = (r: ReturnType<ReturnType<typeof testApp>['request']['get']>) => r.set('X-Account-Id', '1');
const member = (r: ReturnType<ReturnType<typeof testApp>['request']['get']>) => r.set('X-Account-Id', '10');

const ROUTES: [string, Call][] = [
  ['GET /admin/notifications', (t) => admin(t.request.get('/admin/notifications?foo=1'))],
  ['GET /admin/notifications/:id', (t) => admin(t.request.get('/admin/notifications/999999?foo=1'))],
  [
    'GET /admin/notifications/imports/:id',
    (t) => admin(t.request.get('/admin/notifications/imports/999999?foo=1')),
  ],
  [
    'POST /admin/notifications/filter',
    (t) =>
      admin(t.request.post('/admin/notifications/filter?foo=1'))
        .set('Idempotency-Key', randomUUID())
        .send({}),
  ],
  [
    'POST /admin/notifications/event',
    (t) =>
      admin(t.request.post('/admin/notifications/event?foo=1')).set('Idempotency-Key', randomUUID()).send({}),
  ],
  [
    'POST /admin/notifications/imports',
    (t) =>
      admin(t.request.post('/admin/notifications/imports?foo=1'))
        .set('Idempotency-Key', randomUUID())
        .attach('file', Buffer.from('1\n'), 'ids.csv'),
  ],
  [
    'POST /admin/notifications/imports/:id/runs',
    (t) =>
      admin(t.request.post('/admin/notifications/imports/999999/runs?foo=1'))
        .set('Idempotency-Key', randomUUID())
        .send({}),
  ],
  [
    'PATCH /admin/notifications/:id',
    (t) => admin(t.request.patch('/admin/notifications/999999?foo=1')).send({ isActive: false }),
  ],
  ['GET /notifications', (t) => member(t.request.get('/notifications?foo=1'))],
  ['GET /notifications/:id', (t) => member(t.request.get('/notifications/AAAAAAAAAAAAAAA?foo=1'))],
  [
    'PATCH /notifications/:id',
    (t) => member(t.request.patch('/notifications/AAAAAAAAAAAAAAA?foo=1')).send({ isClicked: true }),
  ],
];

describe('unknown query keys', () => {
  it.each(ROUTES)('%s rejects ?foo=1 with 400 VALIDATION_ERROR', async (_name, call) => {
    const res = await call(testApp({ db }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual(EXPECTED);
  });
});
