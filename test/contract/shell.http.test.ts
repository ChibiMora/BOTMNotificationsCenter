import { describe, it, expect, afterAll } from 'vitest';
import { testApp } from '../helpers/app.js';
import { testDb, testConfig } from '../helpers/db.js';

const db = testDb();
afterAll(() => db.destroy());
const config = {
  ...testConfig(),
  rateLimitMemberPerMin: 3,
  rateLimitAdminPerMin: 5,
};

describe('shell: rate limiting (§9.8)', () => {
  it('member limit: 429 + Retry-After; per account; window resets after a minute', async () => {
    const { request, clock } = testApp({ db, config });
    for (let i = 0; i < 3; i++)
      expect((await request.get('/notifications').set('X-Account-Id', '10')).status).toBe(404);
    const r = await request.get('/notifications').set('X-Account-Id', '10');
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'RATE_LIMITED' });
    // FixedClock starts at 14:30:00Z, the very start of a window.
    expect(r.headers['retry-after']).toBe('60');
    clock.advance(15_500);
    const later = await request.get('/notifications').set('X-Account-Id', '10');
    expect(later.status).toBe(429);
    expect(later.headers['retry-after']).toBe('45');
    clock.advance(-15_500);
    expect((await request.get('/notifications').set('X-Account-Id', '11')).status).toBe(404);
    clock.advance(60_000);
    expect((await request.get('/notifications').set('X-Account-Id', '10')).status).toBe(404);
  });
  it('admin limit is separate from the member surface', async () => {
    const { request } = testApp({ db, config });
    for (let i = 0; i < 3; i++) await request.get('/notifications').set('X-Account-Id', '1');
    expect((await request.get('/notifications').set('X-Account-Id', '1')).status).toBe(429);
    for (let i = 0; i < 5; i++)
      expect((await request.get('/admin/x').set('X-Account-Id', '1')).status).toBe(404);
    const r = await request.get('/admin/x').set('X-Account-Id', '1');
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'RATE_LIMITED' });
    expect(r.headers['retry-after']).toBe('60');
  });
  it('state is per app instance', async () => {
    const a = testApp({ db, config }).request;
    for (let i = 0; i < 4; i++) await a.get('/notifications').set('X-Account-Id', '20');
    const b = testApp({ db, config }).request;
    expect((await b.get('/notifications').set('X-Account-Id', '20')).status).toBe(404);
  });
});

describe('shell: health, body parsing, request id', () => {
  const { request } = testApp({ db });
  it('/healthz and /readyz need no session', async () => {
    for (const p of ['/healthz', '/readyz']) {
      const r = await request.get(p);
      expect(r.status, p).toBe(200);
      expect(r.body, p).toEqual({ status: 'ok' });
    }
  });
  it('/healthz and /readyz accept HEAD without a session (load balancers)', async () => {
    for (const p of ['/healthz', '/readyz']) {
      const r = await request.head(p);
      expect(r.status, p).toBe(200);
    }
  });
  it('/readyz 503 when the db ping rejects', async () => {
    const bad = { raw: () => Promise.reject(new Error('down')) } as any;
    const r = await testApp({ db: bad }).request.get('/readyz');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({
      error: 'UNAVAILABLE',
      message: 'database unavailable',
    });
  });
  it('malformed JSON body -> 400 VALIDATION_ERROR', async () => {
    const r = await request
      .post('/notifications')
      .set('X-Account-Id', '10')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: 'VALIDATION_ERROR',
      message: 'malformed JSON body',
    });
  });
  it('body over 1 MB -> 400 VALIDATION_ERROR', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(1024 * 1024 + 10) });
    const r = await request
      .post('/notifications')
      .set('X-Account-Id', '10')
      .set('Content-Type', 'application/json')
      .send(big);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('VALIDATION_ERROR');
  });
  it('X-Request-Id is a UUID on every response, including errors', async () => {
    for (const r of [await request.get('/healthz'), await request.get('/notifications')]) {
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
  it('unknown path -> exactly { error: NOT_FOUND }', async () => {
    const r = await request.get('/nope').set('X-Account-Id', '10');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'NOT_FOUND' });
  });
});
