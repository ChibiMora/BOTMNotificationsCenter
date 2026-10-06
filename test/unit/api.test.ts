import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { loadConfig } from '../../src/config/index.js';

const env = {
  ASSET_BASE_URL: 'https://a.example.com',
  SITE_BASE_URL: 'https://w.example.com',
  DATABASE_URL: 'mysql://r:r@127.0.0.1:3306/x',
};

describe('api composition root', () => {
  it('importing src/api.ts does not listen', async () => {
    const spy = vi.spyOn(http.Server.prototype, 'listen');
    await import('../../src/api.js');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('AUTH_IMPL=header gives the HeaderAuthProvider; unknown impl fails fast', async () => {
    const { selectAuth } = await import('../../src/api.js');
    const { HeaderAuthProvider } = await import('../../src/middleware/headerAuth.js');
    expect(selectAuth(loadConfig({ ...env, AUTH_IMPL: 'header' }))).toBeInstanceOf(HeaderAuthProvider);
    expect(() => selectAuth(loadConfig({ ...env, AUTH_IMPL: 'sso' }))).toThrow(/AUTH_IMPL/);
  });
  it('header stand-in is refused in production (config and composition root)', async () => {
    const { selectAuth } = await import('../../src/api.js');
    expect(() =>
      loadConfig({ ...env, NODE_ENV: 'production', AUTH_IMPL: 'header', QUEUE_IMPL: 'x' }),
    ).toThrow(/refused/);
    const c = { ...loadConfig({ ...env, AUTH_IMPL: 'header' }), production: true };
    expect(() => selectAuth(c)).toThrow(/production/);
  });
  it('QUEUE_IMPL: unknown impl fails fast; db stand-in is refused in production', async () => {
    const { selectQueue } = await import('../../src/api.js');
    const { createLogger } = await import('../../src/lib/logger.js');
    const { systemClock } = await import('../../src/lib/clock.js');
    const { RecordingMetrics } = await import('../helpers/deps.js');
    const parts = {
      db: {} as never,
      clock: systemClock,
      log: createLogger('silent'),
      metrics: new RecordingMetrics(),
    };
    expect(() => selectQueue(loadConfig({ ...env, QUEUE_IMPL: 'sqs' }), parts)).toThrow(/QUEUE_IMPL=sqs/);
    expect(() => loadConfig({ ...env, NODE_ENV: 'production', QUEUE_IMPL: 'db' })).toThrow(/refused/);
    const prod = { ...loadConfig({ ...env, QUEUE_IMPL: 'db' }), production: true };
    expect(() => selectQueue(prod, parts)).toThrow(/QUEUE_IMPL=db \(stand-in\) is refused in production/);
  });
});
