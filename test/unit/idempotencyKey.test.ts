import { describe, it, expect } from 'vitest';
import Koa from 'koa';
import supertest from 'supertest';
import { idempotencyKey } from '../../src/middleware/idempotencyKey.js';
import { errorMapper } from '../../src/middleware/errorMapper.js';
import { createLogger } from '../../src/lib/logger.js';

function app() {
  const a = new Koa();
  a.use(errorMapper());
  a.use(async (ctx, next) => {
    ctx.state.log = createLogger('silent');
    await next();
  });
  a.use(idempotencyKey());
  a.use((ctx) => {
    ctx.body = { key: ctx.state.idempotencyKey };
  });
  return supertest(a.callback());
}

describe('idempotencyKey middleware', () => {
  it('valid UUID passes and is exposed on ctx.state', async () => {
    const k = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const r = await app().post('/').set('Idempotency-Key', k);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ key: k });
  });
  it.each([undefined, '', 'not-a-uuid', '3f2504e0-4f89-41d3-9a0c-0305e82c330'])('400 for %j', async (v) => {
    const req = app().post('/');
    const r = v === undefined ? await req : await req.set('Idempotency-Key', v);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('VALIDATION_ERROR');
  });
});
