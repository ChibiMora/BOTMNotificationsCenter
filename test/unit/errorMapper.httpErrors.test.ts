import { describe, it, expect } from 'vitest';
import Koa from 'koa';
import supertest from 'supertest';
import { errorMapper } from '../../src/middleware/errorMapper.js';
import { AppError } from '../../src/lib/errors.js';

type Rec = { level: string; obj: Record<string, unknown>; msg: string };

function run(fail: (ctx: Koa.Context) => never | void) {
  const logged: Rec[] = [];
  const rec = (level: string) => (obj: Record<string, unknown>, msg: string) =>
    logged.push({ level, obj, msg });
  const log = { error: rec('error'), warn: rec('warn'), info: rec('info') };
  const a = new Koa();
  a.use(async (ctx, next) => {
    ctx.state.log = log;
    await next();
  });
  a.use(errorMapper());
  a.use((ctx) => {
    fail(ctx);
  });
  return { req: supertest(a.callback()).post('/').send({ password: 'hunter2' }), logged };
}
const withProps = (msg: string, p: object) => Object.assign(new Error(msg), p);

describe('errorMapper: http-errors (ctx.throw / ctx.assert)', () => {
  it.each<[number, number, string]>([
    [400, 400, 'VALIDATION_ERROR'],
    [401, 401, 'UNAUTHORIZED'],
    [403, 403, 'FORBIDDEN'],
    [404, 404, 'NOT_FOUND'],
    [409, 409, 'CONFLICT'],
    [429, 429, 'RATE_LIMITED'],
    [418, 400, 'VALIDATION_ERROR'],
    [422, 400, 'VALIDATION_ERROR'],
  ])('ctx.throw(%i) -> %i %s', async (thrown, status, code) => {
    const r = await run((ctx) => ctx.throw(thrown, 'exposed message')).req;
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ error: code, message: 'exposed message' });
  });
  it('ctx.assert failure -> 400 VALIDATION_ERROR with its message', async () => {
    const r = await run((ctx) => ctx.assert(false, 400, 'id required')).req;
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'VALIDATION_ERROR', message: 'id required' });
  });
  it('unexposed 4xx http-error carries no message', async () => {
    const r = await run(() => {
      throw withProps('internal reason', { status: 404, expose: false });
    }).req;
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'NOT_FOUND' });
  });
  it('5xx http-error stays 500 INTERNAL', async () => {
    const r = await run((ctx) => ctx.throw(502, 'upstream')).req;
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'INTERNAL' });
  });
  it('explicit rows win: AppError with a status is not re-mapped', async () => {
    const r = await run(() => {
      throw new AppError('CONFLICT', 409, 'dup');
    }).req;
    expect(r.body).toEqual({ error: 'CONFLICT', message: 'dup' });
  });
});

describe('errorMapper: logging and neutral 503 message', () => {
  it('connection-type error: neutral message, logged at warn without body', async () => {
    const { req, logged } = run(() => {
      throw withProps('connect ETIMEDOUT 10.0.0.1:443', { code: 'ETIMEDOUT' });
    });
    const r = await req;
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'UNAVAILABLE', message: 'service temporarily unavailable' });
    const warns = logged.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).toContain('ETIMEDOUT');
    expect(JSON.stringify(logged)).not.toContain('hunter2');
  });
  it('mapped AppError 503 (auth provider) is logged at warn', async () => {
    const { req, logged } = run(() => {
      throw new AppError('UNAVAILABLE', 503, 'role system unavailable');
    });
    expect((await req).status).toBe(503);
    expect(logged.filter((l) => l.level === 'warn')).toHaveLength(1);
  });
  it('3572 lock conflict is logged at warn', async () => {
    const { req, logged } = run(() => {
      throw withProps('lock', { errno: 3572, code: 'ER_LOCK_NOWAIT' });
    });
    expect((await req).status).toBe(409);
    const warns = logged.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).toContain('ER_LOCK_NOWAIT');
  });
  it('ordinary mapped 4xx is not logged as warn/error', async () => {
    const { req, logged } = run(() => {
      throw new AppError('NOT_FOUND', 404);
    });
    await req;
    expect(logged.filter((l) => l.level !== 'info')).toHaveLength(0);
  });
});
