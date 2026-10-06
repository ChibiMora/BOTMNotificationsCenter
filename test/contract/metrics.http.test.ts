// §11.4/§11.5 through the real app: readiness failing on the API, and route templates for member routes.
import { describe, it, expect, afterAll } from 'vitest';
import { testApp } from '../helpers/app.js';
import { RecordingMetrics } from '../helpers/deps.js';

const metrics = new RecordingMetrics();
const t = testApp({ metrics });
afterAll(() => t.close());

describe('API metrics', () => {
  it('/readyz 503 counts readiness_failed{process=api}', async () => {
    const m = new RecordingMetrics();
    const broken = Object.assign(() => undefined, {
      raw: async () => Promise.reject(new Error('down')),
    }) as any;
    const b = testApp({ db: broken, metrics: m });
    expect((await b.request.get('/readyz')).status).toBe(503);
    expect(m.calls).toContainEqual({
      kind: 'count',
      name: 'readiness_failed',
      value: 1,
      dims: { process: 'api' },
    });
    expect(m.calls).toContainEqual(
      expect.objectContaining({ name: 'http_5xx', dims: { route: 'unmatched', status: '503' } }),
    );
  });

  it('a member GET of an unknown id is a member_not_found under the route template', async () => {
    metrics.calls = [];
    const r = await t.request.get('/notifications/doesnotexist0000').set('X-Account-Id', '5');
    expect(r.status).toBe(404);
    expect(metrics.calls.filter((c) => c.name === 'member_not_found')).toHaveLength(1);
    expect(metrics.calls).toContainEqual(
      expect.objectContaining({
        name: 'http_requests',
        dims: { method: 'GET', route: '/notifications/:id', status: '404' },
      }),
    );
    expect(JSON.stringify(metrics.calls)).not.toContain('doesnotexist');
  });
});
