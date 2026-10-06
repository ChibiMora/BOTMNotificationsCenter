import { describe, it, expect, afterAll } from 'vitest';
import { pino } from 'pino';
import type { Deps } from '../../src/lib/deps.js';
import { adminRouter } from '../../src/admin/router.js';
import { memberRouter } from '../../src/member/router.js';
import { testApp } from '../helpers/app.js';
import { testDb, testConfig } from '../helpers/db.js';

const db = testDb();
afterAll(() => db.destroy());

/** The real routers (so their options are under test) with probe routes added. */
function probeRouters(d: Deps) {
  const admin = adminRouter(d);
  admin.get('/secret', (ctx) => {
    ctx.body = { secret: 'admin-only' };
  });
  // Slash-less registrations: the prefix is concatenated, so these serve /admin-x, /admin.json, /admin<id>.json.
  admin.get('-x', (ctx) => {
    ctx.body = { secret: 'admin-only' };
  });
  admin.get('.json', (ctx) => {
    ctx.body = { secret: 'admin-only' };
  });
  admin.get(':id.json', (ctx) => {
    ctx.body = { secret: 'admin-only' };
  });
  const member = memberRouter(d);
  member.get('/notifications/:id', (ctx) => {
    ctx.body = { id: ctx.params.id };
  });
  member.post('/probe/echo', (ctx) => {
    ctx.body = { length: JSON.stringify(ctx.request.body).length };
  });
  member.get('/probe/boom', () => {
    throw new Error('secret internal detail');
  });
  member.get('/probe/dbfail', async () => {
    await d.db('notifications').insert({ headline: 'SECRET-MARKER' });
  });
  return { admin, member };
}
const app = (o: Partial<Deps> = {}) => testApp({ db, ...o }, { routers: probeRouters });

describe('shell: admin gate is case-insensitive and airtight (§3.1, §9.1)', () => {
  const { request } = app();
  it('non-admin gets 403 on every casing / slash variant of an admin path, never the body', async () => {
    for (const p of ['/admin/secret', '/Admin/secret', '/ADMIN/secret', '/admin/secret/', '/admin//secret']) {
      const r = await request.get(p).set('X-Account-Id', '10');
      expect(r.status, p).toBe(403);
      expect(r.body, p).toEqual({ error: 'FORBIDDEN' });
    }
  });
  it('admin gets 200 only on the exact-case path, 404 on other casings', async () => {
    const ok = await request.get('/admin/secret').set('X-Account-Id', '1');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ secret: 'admin-only' });
    for (const p of ['/Admin/secret', '/ADMIN/secret', '/admin/SECRET']) {
      const r = await request.get(p).set('X-Account-Id', '1');
      expect(r.status, p).toBe(404);
      expect(r.body, p).toEqual({ error: 'NOT_FOUND' });
    }
  });
  it('encoded / doubled-slash variants never reach the admin route for a non-admin', async () => {
    for (const p of ['//admin/secret', '/admin%2Fsecret', '/%61dmin/secret', '/%41dmin/secret']) {
      const r = await request.get(p).set('X-Account-Id', '10');
      expect(r.status, p).not.toBe(200);
      expect(JSON.stringify(r.body), p).not.toContain('admin-only');
    }
  });
  it('slash-less admin routes (/admin-x, /admin.json, /admin<id>.json) are gated too', async () => {
    for (const p of ['/admin-x', '/admin.json', '/adminfoo.json', '/ADMIN-X']) {
      const r = await request.get(p).set('X-Account-Id', '10');
      expect(r.status, p).toBe(403);
      expect(r.body, p).toEqual({ error: 'FORBIDDEN' });
    }
    for (const p of ['/admin-x', '/admin.json', '/adminfoo.json']) {
      const r = await request.get(p).set('X-Account-Id', '1');
      expect(r.status, p).toBe(200);
      expect(r.body, p).toEqual({ secret: 'admin-only' });
    }
  });
  it('slash-less admin routes are charged to the admin bucket', async () => {
    const config = {
      ...testConfig(),
      rateLimitMemberPerMin: 2,
      rateLimitAdminPerMin: 3,
    };
    const { request: rq } = app({ config });
    for (const p of ['/admin-x', '/admin.json', '/adminfoo.json']) {
      expect((await rq.get(p).set('X-Account-Id', '1')).status, p).toBe(200);
    }
    for (let i = 0; i < 2; i++) {
      expect((await rq.get('/notifications/1').set('X-Account-Id', '1')).status).toBe(200);
    }
    expect((await rq.get('/admin-x').set('X-Account-Id', '1')).status).toBe(429);
    expect((await rq.get('/notifications/1').set('X-Account-Id', '1')).status).toBe(429);
  });
  it('member route is unaffected by the admin gate', async () => {
    const r = await request.get('/notifications/42').set('X-Account-Id', '10');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: '42' });
  });
  it('every casing of an admin path charges the admin bucket, not the member one', async () => {
    const config = {
      ...testConfig(),
      rateLimitMemberPerMin: 2,
      rateLimitAdminPerMin: 3,
    };
    const { request: rq } = app({ config });
    for (const p of ['/Admin/x', '/ADMIN/x', '/aDmIn/x']) {
      expect((await rq.get(p).set('X-Account-Id', '1')).status, p).toBe(404);
    }
    for (let i = 0; i < 2; i++) {
      expect((await rq.get('/notifications/1').set('X-Account-Id', '1')).status).toBe(200);
    }
    const r = await rq.get('/admin/secret').set('X-Account-Id', '1');
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'RATE_LIMITED' });
  });
});

describe('shell: routing and error envelope through createApp', () => {
  it('wrong method on an existing path -> 404 NOT_FOUND envelope (no 405 in the contract)', async () => {
    const r = await app().request.post('/notifications/1').set('X-Account-Id', '10');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'NOT_FOUND' });
    expect(r.headers.allow).toBeUndefined();
  });
  it('unexpected error -> exactly { error: INTERNAL }, nothing leaks', async () => {
    const r = await app().request.get('/probe/boom').set('X-Account-Id', '10');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'INTERNAL' });
    expect(r.text).not.toContain('secret');
  });
  it('database error during an insert: 500 INTERNAL, bound values never reach the logs', async () => {
    // A real pino logger (same default serializers as createLogger) writing to an in-memory stream.
    let out = '';
    const log = pino({ level: 'debug' }, { write: (chunk: string) => void (out += chunk) });
    const r = await app({ log }).request.get('/probe/dbfail').set('X-Account-Id', '10');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'INTERNAL' });
    expect(out).toContain('unhandled error');
    expect(out).toContain("Field 'type' doesn't have a default value");
    expect(out).not.toContain('SECRET-MARKER');
  });
  it('JSON cap is 1 MB: just under reaches the route, just over is 400', async () => {
    const { request } = app();
    const send = (n: number) =>
      request
        .post('/probe/echo')
        .set('X-Account-Id', '10')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ a: 'x'.repeat(n) }));
    const under = await send(1024 * 1024 - 100);
    expect(under.status).toBe(200);
    expect(under.body).toEqual({ length: 1024 * 1024 - 100 + 8 });
    // The server may answer 400 and close before the client finishes writing (ECONNRESET/EPIPE on the client);
    // retry only that transport race, the asserted response is unchanged.
    const sendOver = async (tries = 5): Promise<Awaited<ReturnType<typeof send>>> => {
      try {
        return await send(1024 * 1024);
      } catch (err) {
        if (tries > 1 && /ECONNRESET|EPIPE/.test(String((err as Error).message))) return sendOver(tries - 1);
        throw err;
      }
    };
    const over = await sendOver();
    expect(over.status).toBe(400);
    expect(over.body).toEqual({
      error: 'VALIDATION_ERROR',
      message: 'request body too large',
    });
  });
  it('request log line carries the route template, not the concrete URL', async () => {
    const lines: Record<string, unknown>[] = [];
    const log: any = {
      info: (o: Record<string, unknown>) => lines.push(o),
      warn() {},
      error() {},
    };
    log.child = () => log;
    await app({ log }).request.get('/notifications/77').set('X-Account-Id', '10');
    const line = lines.find((l) => 'route' in l);
    expect(line?.route).toBe('/notifications/:id');
  });
});
