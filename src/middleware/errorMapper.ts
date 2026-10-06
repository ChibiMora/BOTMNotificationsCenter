/** Error mapping (§9.3): renders every failure as the §3.2 envelope { error, message? }. */
import type Koa from 'koa';
import { ZodError } from 'zod';
import { AppError, type ErrorCode } from '../lib/errors.js';

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_CON_COUNT_ERROR',
]);
const MULTIPART_MESSAGES = [
  /^Multipart:/,
  /^Unexpected end of (form|multipart data)/,
  /^Malformed part header/,
];
const LOCK_NOWAIT_ERRNO = 3572;

/** `warn`: log the cause at warn (mapped 503s and the NOWAIT lock conflict); other mapped errors are not logged. */
type Mapped = { status: number; code: ErrorCode; message?: string; warn?: boolean };

/** http-errors (ctx.throw, ctx.assert) 4xx status → contract code; any other 4xx is a 400 VALIDATION_ERROR. */
const HTTP_ERROR_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

/** Pure mapping from a thrown value to status/code/message; undefined means "anything else" (500). */
export function mapError(err: unknown): Mapped | undefined {
  if (err instanceof AppError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message === err.code ? undefined : err.message,
      warn: err.status === 503,
    };
  }
  if (err instanceof ZodError) {
    return { status: 400, code: 'VALIDATION_ERROR', message: err.issues[0]?.message };
  }
  const e = (err ?? {}) as {
    name?: string;
    code?: string;
    errno?: number;
    type?: string;
    message?: string;
    status?: number;
    expose?: boolean;
  };
  if (e.name === 'MulterError') {
    return { status: 400, code: 'VALIDATION_ERROR', message: e.message };
  }
  if (typeof e.message === 'string' && MULTIPART_MESSAGES.some((re) => re.test(e.message as string))) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'malformed multipart body' };
  }
  // koa-bodyparser / co-body / raw-body errors: malformed JSON, body over the cap, bad encoding.
  if (typeof e.type === 'string' && /^(entity|encoding|request|charset)\./.test(e.type)) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: e.type === 'entity.too.large' ? 'request body too large' : 'malformed request body',
    };
  }
  // co-body's JSON.parse failure: a SyntaxError with status 400 (and no `type`).
  if (err instanceof SyntaxError && e.status === 400) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'malformed JSON body' };
  }
  if (e.errno === LOCK_NOWAIT_ERRNO) {
    return { status: 409, code: 'CONFLICT', message: 'another update is in progress', warn: true };
  }
  if (e.name === 'KnexTimeoutError' || (typeof e.code === 'string' && CONNECTION_CODES.has(e.code))) {
    // Connection codes may come from any dependency, not only the database: keep the message neutral.
    return { status: 503, code: 'UNAVAILABLE', message: 'service temporarily unavailable', warn: true };
  }
  // http-errors (ctx.throw / ctx.assert): a boolean `expose` and a 4xx status; message only when exposed.
  if (typeof e.expose === 'boolean' && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
    const code = HTTP_ERROR_CODES[e.status];
    return {
      status: code ? e.status : 400,
      code: code ?? 'VALIDATION_ERROR',
      message: e.expose && typeof e.message === 'string' ? e.message : undefined,
    };
  }
  return undefined;
}

export function errorMapper(): Koa.Middleware {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      const mapped = mapError(err);
      if (mapped) {
        if ((err as { type?: string }).type === 'entity.too.large') {
          // raw-body pauses the request on the limit error; drain it so the client can read the 400 instead of a
          // connection reset mid-upload. Discarded bytes are never buffered.
          ctx.req.resume();
        }
        if (mapped.warn) {
          // The error only, never the request body.
          ctx.state.log?.warn({ err }, 'mapped error');
        }
        ctx.status = mapped.status;
        ctx.body =
          mapped.message === undefined
            ? { error: mapped.code }
            : { error: mapped.code, message: mapped.message };
        return;
      }
      const stack = err instanceof Error ? err.stack : String(err);
      ctx.state.log?.error({ err, stack }, 'unhandled error');
      ctx.status = 500;
      ctx.body = { error: 'INTERNAL' };
    }
  };
}
