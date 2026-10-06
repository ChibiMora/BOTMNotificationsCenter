// U10 polish: probe route labels, worker readiness_failed only on a failed ping, readable configuration errors.
import { describe, it, expect } from 'vitest';
import Koa from 'koa';
import http from 'node:http';
import supertest from 'supertest';
import { requestContext } from '../../src/middleware/requestContext.js';
import { healthHandler } from '../../src/worker.js';
import { loadConfig } from '../../src/config/index.js';
import { FixedClock } from '../helpers/clock.js';
import { RecordingMetrics } from '../helpers/deps.js';

const log = { child: () => ({ info: () => {}, warn: () => {} }) } as any;

describe('probe routes are labelled with their own fixed route value', () => {
  it('/healthz and /readyz (503) are not counted as unmatched', async () => {
    const metrics = new RecordingMetrics();
    const a = new Koa();
    a.use(requestContext({ log, clock: new FixedClock(), metrics }));
    a.use((ctx) => {
      ctx.status = ctx.path === '/readyz' ? 503 : ctx.path === '/healthz' ? 200 : 404;
      ctx.body = {};
    });
    const s = supertest(a.callback());
    await s.get('/healthz');
    await s.get('/readyz');
    await s.get('/nowhere');
    const routes = (n: string) => metrics.calls.filter((c) => c.name === n).map((c) => c.dims?.route);
    expect(routes('http_requests')).toEqual(['/healthz', '/readyz', 'unmatched']);
    expect(routes('http_request_duration_ms')).toEqual(['/healthz', '/readyz', 'unmatched']);
    expect(routes('http_5xx')).toEqual(['/readyz']);
  });
});

describe('worker readiness_failed', () => {
  const ok = { raw: async () => [] } as any;
  const broken = { raw: async () => Promise.reject(new Error('down')) } as any;
  it('is not counted when the worker is merely shutting down (still 503)', async () => {
    const m = new RecordingMetrics();
    const r = await supertest(http.createServer(healthHandler(ok, () => false, m))).get('/readyz');
    expect(r.status).toBe(503);
    expect(m.calls.filter((c) => c.name === 'readiness_failed')).toEqual([]);
  });
  it('is counted when the database ping fails', async () => {
    const m = new RecordingMetrics();
    const r = await supertest(http.createServer(healthHandler(broken, () => true, m))).get('/readyz');
    expect(r.status).toBe(503);
    expect(m.calls.filter((c) => c.name === 'readiness_failed')).toMatchObject([
      { dims: { process: 'worker' } },
    ]);
  });
});

describe('configuration errors', () => {
  it('name each missing/invalid variable on its own line, no ZodError JSON dump', () => {
    let msg = '';
    try {
      loadConfig({ PORT: 'abc' });
    } catch (e) {
      msg = (e as Error).message;
    }
    const lines = msg.split('\n');
    expect(lines[0]).toBe('invalid configuration:');
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}DATABASE_URL: /));
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}PORT: /));
    expect(msg).not.toContain('"code"');
  });
});
