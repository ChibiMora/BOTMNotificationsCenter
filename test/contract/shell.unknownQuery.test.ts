/** Contract: every admin and member route rejects unknown query-string keys like the list endpoints do (§3.2). */
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Router from '@koa/router';
import { testApp } from '../helpers/app.js';
import { testDb } from '../helpers/db.js';
import { makeTestDeps } from '../helpers/deps.js';
import { adminRouter } from '../../src/admin/router.js';
import { memberRouter } from '../../src/member/router.js';

const db = testDb();
afterAll(() => db.destroy());

// Status and error code are contract; zod's message text is not.
const EXPECTED = { error: 'VALIDATION_ERROR' };

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
    expect(res.body).toMatchObject(EXPECTED);
  });

  it('ROUTES covers every route registered on the admin and member routers', () => {
    const deps = makeTestDeps({ db });
    // Paths as registered (the admin router carries its own /admin prefix); HEAD is koa-router's implicit twin of GET.
    const registered = (router: Router, prefix: string) =>
      router.stack.flatMap((l) =>
        l.methods.filter((m) => m !== 'HEAD').map((m) => `${m} ${prefix}${l.path}`),
      );
    const all = [...registered(adminRouter(deps), ''), ...registered(memberRouter(deps), '')];
    expect(all.length).toBeGreaterThan(0);
    expect([...new Set(all)].sort()).toEqual(ROUTES.map(([name]) => name).sort());
  });
});

describe('unknown query keys: precedence (§9.1 requireAdmin → [idempotencyKey] → validate)', () => {
  it.each(['/admin/notifications/999999?foo=1', '/notifications/AAAAAAAAAAAAAAA?foo=1'])(
    'no session + ?foo=1 on %s → 401 UNAUTHORIZED',
    async (path) => {
      const res = await testApp({ db }).request.get(path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
    },
  );

  it('non-admin + ?foo=1 on an admin route → the admin gate 403 FORBIDDEN, not 400', async () => {
    const res = await member(testApp({ db }).request.get('/admin/notifications/999999?foo=1'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN' });
  });

  it.each([
    '/admin/notifications/filter?foo=1',
    '/admin/notifications/event?foo=1',
    '/admin/notifications/imports/999999/runs?foo=1',
  ])('POST %s without Idempotency-Key → the Idempotency-Key error', async (path) => {
    const res = await admin(testApp({ db }).request.post(path)).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'VALIDATION_ERROR', message: 'Idempotency-Key header must be a UUID' });
  });

  it('POST /admin/notifications/imports?foo=1 without Idempotency-Key → the Idempotency-Key error', async () => {
    const res = await admin(testApp({ db }).request.post('/admin/notifications/imports?foo=1')).attach(
      'file',
      Buffer.from('1\n'),
      'ids.csv',
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'VALIDATION_ERROR', message: 'Idempotency-Key header must be a UUID' });
  });
});
