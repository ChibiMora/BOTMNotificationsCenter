import { describe, it, expect } from 'vitest';
import Koa from 'koa';
import supertest from 'supertest';
import { requestContext } from '../../src/middleware/requestContext.js';
import { FixedClock } from '../helpers/clock.js';

describe('requestContext', () => {
  it('sets X-Request-Id and logs one line with id, method, status, duration, accountId and no body', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const log = { child: () => ({ info: (o: Record<string, unknown>) => lines.push(o) }) } as any;
    const clock = new FixedClock();
    const app = new Koa();
    app.use(requestContext({ log, clock }));
    app.use((ctx) => {
      ctx.state.accountId = 7;
      clock.advance(25);
      ctx.status = 201;
      ctx.body = { secret: 'content' };
    });
    const r = await supertest(app.callback())
      .post('/x')
      .set('Authorization', 'token-abc')
      .send({ secret: 'content' });
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      requestId: r.headers['x-request-id'],
      method: 'POST',
      status: 201,
      durationMs: 25,
      accountId: 7,
    });
    expect(JSON.stringify(lines)).not.toMatch(/secret|token-abc/);
  });
});
