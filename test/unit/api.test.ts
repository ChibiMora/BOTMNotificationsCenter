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
  it('queue selection is not wired yet and fails clearly', async () => {
    const { selectQueue } = await import('../../src/api.js');
    expect(() => selectQueue(loadConfig(env))).toThrow(/queue implementation not wired/);
  });
});
