// §11.4 request metrics (U10): count/duration/status by route template, member 404s, 5xx, readiness failing.
import { describe, it, expect } from 'vitest';
import Koa from 'koa';
import Router from '@koa/router';
import http from 'node:http';
import supertest from 'supertest';
import { requestContext } from '../../src/middleware/requestContext.js';
import { healthHandler } from '../../src/worker.js';
import { FixedClock } from '../helpers/clock.js';
import { RecordingMetrics } from '../helpers/deps.js';

const log = { child: () => ({ info: () => {}, warn: () => {} }) } as any;

function app(metrics: RecordingMetrics, clock: FixedClock) {
  const a = new Koa();
  a.use(requestContext({ log, clock, metrics }));
  const r = new Router();
  r.get('/notifications/:id', (ctx) => {
    clock.advance(40);
    ctx.status = ctx.params.id === 'nope' ? 404 : 200;
    ctx.body = {};
  });
  r.get('/admin/boom', (ctx) => {
    ctx.status = 503;
    ctx.body = {};
  });
  a.use(r.routes());
  return a;
}

describe('request metrics', () => {
  it('emits http_requests and http_request_duration_ms by method, route template and status', async () => {
    const m = new RecordingMetrics();
    const clock = new FixedClock();
    await supertest(app(m, clock).callback()).get('/notifications/abc123');
    const dims = { method: 'GET', route: '/notifications/:id', status: '200' };
    expect(m.calls).toContainEqual({ kind: 'count', name: 'http_requests', value: 1, dims });
    expect(m.calls).toContainEqual({ kind: 'timing', name: 'http_request_duration_ms', value: 40, dims });
    expect(JSON.stringify(m.calls)).not.toContain('abc123');
    expect(m.calls.map((c) => c.name)).not.toContain('member_not_found');
  });

  it('uses "unmatched" for a path no route matches', async () => {
    const m = new RecordingMetrics();
    await supertest(app(m, new FixedClock()).callback()).get('/secret/42');
    expect(m.calls).toContainEqual(
      expect.objectContaining({
        name: 'http_requests',
        dims: { method: 'GET', route: 'unmatched', status: '404' },
      }),
    );
    expect(JSON.stringify(m.calls)).not.toContain('42');
  });

  it('counts member_not_found on a member-route 404 without the id', async () => {
    const m = new RecordingMetrics();
    await supertest(app(m, new FixedClock()).callback()).get('/notifications/nope');
    const c = m.calls.filter((x) => x.name === 'member_not_found');
    expect(c).toHaveLength(1);
    expect(JSON.stringify(c)).not.toContain('nope');
  });

  it('counts http_5xx with route and status', async () => {
    const m = new RecordingMetrics();
    await supertest(app(m, new FixedClock()).callback()).get('/admin/boom');
    expect(m.calls).toContainEqual({
      kind: 'count',
      name: 'http_5xx',
      value: 1,
      dims: { route: '/admin/boom', status: '503' },
    });
  });

  it('worker /readyz counts readiness_failed{process=worker} when it answers 503', async () => {
    const m = new RecordingMetrics();
    const broken = { raw: async () => Promise.reject(new Error('down')) } as any;
    const r = await supertest(http.createServer(healthHandler(broken, () => true, m))).get('/readyz');
    expect(r.status).toBe(503);
    expect(m.calls).toEqual([
      { kind: 'count', name: 'readiness_failed', value: 1, dims: { process: 'worker' } },
    ]);
  });
});
