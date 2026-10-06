import { describe, it, expect } from 'vitest';
import Koa from 'koa';
import supertest from 'supertest';
import { z } from 'zod';
import { errorMapper } from '../../src/middleware/errorMapper.js';
import { AppError } from '../../src/lib/errors.js';

function run(err: unknown) {
  const logged: unknown[] = [];
  const log = { error: (...a: unknown[]) => logged.push(a), warn: () => {}, info: () => {} } as any;
  const a = new Koa();
  a.use(async (ctx, next) => {
    ctx.state.log = log;
    await next();
  });
  a.use(errorMapper());
  a.use(() => {
    throw err;
  });
  return { req: supertest(a.callback()).get('/'), logged };
}
const zodErr = (() => {
  const r = z.object({ a: z.string({ message: 'a must be a string' }) }).safeParse({ a: 1 });
  return r.success ? null : r.error;
})();
const withProps = (msg: string, p: object) => Object.assign(new Error(msg), p);

describe('errorMapper (§9.3)', () => {
  it.each<[string, unknown, number, string, string | undefined]>([
    ['AppError', new AppError('NOT_FOUND', 404, 'no such thing'), 404, 'NOT_FOUND', 'no such thing'],
    ['AppError without message', new AppError('FORBIDDEN', 403), 403, 'FORBIDDEN', undefined],
    ['zod error', zodErr, 400, 'VALIDATION_ERROR', 'a must be a string'],
    [
      'multer limit',
      withProps('File too large', { name: 'MulterError', code: 'LIMIT_FILE_SIZE' }),
      400,
      'VALIDATION_ERROR',
      'File too large',
    ],
    ['malformed multipart', new Error('Unexpected end of form'), 400, 'VALIDATION_ERROR', undefined],
    [
      'malformed multipart boundary',
      new Error('Multipart: Boundary not found'),
      400,
      'VALIDATION_ERROR',
      undefined,
    ],
    [
      'malformed JSON',
      withProps('Unexpected token', { status: 400, type: 'entity.parse.failed', expose: true }),
      400,
      'VALIDATION_ERROR',
      undefined,
    ],
    [
      'malformed JSON (co-body SyntaxError)',
      Object.assign(new SyntaxError('Unexpected end of JSON input'), { status: 400 }),
      400,
      'VALIDATION_ERROR',
      undefined,
    ],
    ['NOWAIT lock', withProps('lock', { errno: 3572, code: 'ER_LOCK_NOWAIT' }), 409, 'CONFLICT', undefined],
    ['connection refused', withProps('conn', { code: 'ECONNREFUSED' }), 503, 'UNAVAILABLE', undefined],
    [
      'connection lost',
      withProps('lost', { code: 'PROTOCOL_CONNECTION_LOST', fatal: true }),
      503,
      'UNAVAILABLE',
      undefined,
    ],
    [
      'pool timeout',
      withProps('Knex: Timeout acquiring a connection', { name: 'KnexTimeoutError' }),
      503,
      'UNAVAILABLE',
      undefined,
    ],
  ])('%s', async (_n, err, status, code, message) => {
    const r = await run(err).req;
    expect(r.status).toBe(status);
    expect(r.body.error).toBe(code);
    if (message !== undefined) expect(r.body.message).toBe(message);
    expect(Object.keys(r.body).every((k) => k === 'error' || k === 'message')).toBe(true);
  });
  it('anything else: 500 INTERNAL, no detail, logged with stack', async () => {
    const { req, logged } = run(new Error('secret db detail'));
    const r = await req;
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'INTERNAL' });
    expect(JSON.stringify(logged)).toContain('secret db detail');
    expect(JSON.stringify(logged)).toContain('stack');
  });
});
