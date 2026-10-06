/**
 * POST /admin/notifications/imports/:id/runs (§3.4, §7.3): starts a new run of an import whose latest run failed.
 *
 * Idempotency: same-endpoint races are covered by the unique index on import_runs.request_key. The cross-endpoint key
 * checks (notifications / imports) are plain reads before the insert, so two concurrent requests using one key on two
 * DIFFERENT endpoints can both succeed: there is no cross-table unique constraint.
 */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import type { Logger } from '../lib/logger.js';
import { AppError, validationError } from '../lib/errors.js';
import { truncateToSecond } from '../lib/time.js';
import { withTransaction } from '../db/index.js';
import { idParamSchema } from './schemas.js';

const DIFFERENT_REQUEST = 'Idempotency-Key already used for a different request';
const conflict = () => new AppError('CONFLICT', 409, 'the latest run of this import has not failed');

/** True when the key was already used by another endpoint (an import upload or a filter/event create). */
async function keyUsedElsewhere(deps: Deps, key: string): Promise<boolean> {
  const [n, i] = await Promise.all([
    deps.db('notifications').where({ request_key: key }).first('id'),
    deps.db('imports').where({ request_key: key }).first('id'),
  ]);
  return Boolean(n || i);
}

const isDuplicateRunKey = (err: unknown) => {
  const e = err as { code?: string; message?: string; sqlMessage?: string };
  return (
    e?.code === 'ER_DUP_ENTRY' &&
    `${e.message ?? ''} ${e.sqlMessage ?? ''}`.includes('uq_import_runs_request_key')
  );
};

/** The run already created with this key: the same run for the same import, otherwise a 400. */
async function replay(deps: Deps, ctx: Koa.Context, importId: number, key: string): Promise<boolean> {
  const run = await deps.db('import_runs').where({ request_key: key }).first('id', 'import_id');
  if (!run) return false;
  if (run.import_id !== importId) throw validationError(DIFFERENT_REQUEST);
  const imp = await deps.db('imports').where({ id: importId }).first('notification_id');
  ctx.status = 202;
  ctx.body = { id: run.id, importId, notificationId: imp.notification_id };
  return true;
}

export async function createImportRun(deps: Deps, ctx: Koa.Context) {
  const importId = idParamSchema.parse(ctx.params.id);
  const key = ctx.state.idempotencyKey as string;
  if (await replay(deps, ctx, importId, key)) return;
  if (await keyUsedElsewhere(deps, key)) throw validationError(DIFFERENT_REQUEST);

  const imp = await deps.db('imports').where({ id: importId }).first('id', 'notification_id');
  if (!imp) throw new AppError('NOT_FOUND', 404);
  const latestStatus = async (q: Deps['db']) =>
    (await q('import_runs').where({ import_id: importId }).orderBy('id', 'desc').first('status'))?.status;
  if ((await latestStatus(deps.db)) !== 'failed') throw conflict();

  const now = truncateToSecond(deps.clock.now());
  let runId: number;
  try {
    runId = await withTransaction(deps.db, async (trx) => {
      await trx.raw('SELECT id FROM imports WHERE id = ? FOR UPDATE', [importId]);
      if ((await latestStatus(trx)) !== 'failed') throw conflict();
      const [id] = await trx('import_runs').insert({
        import_id: importId,
        status: 'processing',
        started_at: now,
        request_key: key,
      });
      await trx('imports').where({ id: importId }).update({ status: 'processing', updated_at: now });
      return id!;
    });
  } catch (err) {
    if (isDuplicateRunKey(err) && (await replay(deps, ctx, importId, key))) return;
    throw err;
  }

  // Enqueue after commit; a failed enqueue does not fail the request (housekeeping re-enqueues).
  try {
    await deps.queue.enqueue('process_import', { importId, runId, requestId: ctx.state.requestId });
  } catch (err) {
    const log = (ctx.state.log as Logger | undefined) ?? deps.log;
    log.error({ err, importId, runId }, 'process_import enqueue failed');
  }
  ctx.status = 202;
  ctx.body = { id: runId, importId, notificationId: imp.notification_id };
}
