import { describe, it, expect, afterAll } from 'vitest';
import { testApp } from '../helpers/app.js';
import { testDb } from '../helpers/db.js';

const db = testDb();
afterAll(() => db.destroy());

describe('shell: authentication and admin gate', () => {
  const { request } = testApp({ db });
  it.each(['/admin/notifications', '/notifications'])('401 on %s without a session', async (path) => {
    for (const id of [undefined, 'abc', '1x']) {
      const r = id === undefined ? await request.get(path) : await request.get(path).set('X-Account-Id', id);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'UNAUTHORIZED' });
    }
  });
  it('403 for a non-admin on any /admin path', async () => {
    for (const path of ['/admin', '/admin/notifications', '/admin/anything/at/all']) {
      const r = await request.post(path).set('X-Account-Id', '10');
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'FORBIDDEN' });
    }
  });
  it('admins 1-3 pass the gate (unknown route then 404)', async () => {
    for (const id of ['1', '2', '3']) {
      const r = await request.get('/admin/nope').set('X-Account-Id', id);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: 'NOT_FOUND' });
    }
  });
  it('authenticated unknown route -> 404 envelope', async () => {
    const r = await request.get('/whatever').set('X-Account-Id', '10');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'NOT_FOUND' });
  });
  it('503 when getSession throws, and when isAdmin throws (never 403, never allowed)', async () => {
    const boom = async () => {
      throw new Error('session system down');
    };
    const a = testApp({ db, auth: { getSession: boom, isAdmin: async () => true } }).request;
    const r1 = await a.get('/notifications').set('X-Account-Id', '1');
    expect(r1.status).toBe(503);
    expect(r1.body).toEqual({ error: 'UNAVAILABLE', message: 'session system unavailable' });
    const b = testApp({ db, auth: { getSession: async () => ({ accountId: 1 }), isAdmin: boom } }).request;
    const r2 = await b.get('/admin/notifications');
    expect(r2.status).toBe(503);
    expect(r2.body).toEqual({ error: 'UNAVAILABLE', message: 'role system unavailable' });
  });
});
