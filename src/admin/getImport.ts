/** GET /admin/notifications/imports/:id (§3.4): status and row-level report of one import. */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import { notFound } from '../lib/errors.js';
import { formatTimestamp } from '../lib/time.js';
import { idParamSchema } from './schemas.js';

export async function getImport(deps: Deps, ctx: Koa.Context) {
  const id = idParamSchema.parse(ctx.params.id);
  const imp = await deps
    .db('imports')
    .where({ id })
    .first('id', 'notification_id', 'status', 'total_rows', 'accepted', 'duplicates_ignored');
  if (!imp) throw notFound('import');
  const [runs, errors] = await Promise.all([
    deps
      .db('import_runs')
      .where({ import_id: id })
      .orderBy('id')
      .select('id', 'status', 'started_at', 'finished_at', 'error'),
    imp.status === 'processing'
      ? []
      : deps
          .db('import_row_errors')
          .where({ import_id: id })
          .orderBy('row_num')
          .select('row_num', 'account_id', 'reason'),
  ]);
  ctx.body = {
    id: imp.id,
    notificationId: imp.notification_id,
    status: imp.status,
    totalRows: imp.total_rows,
    accepted: imp.accepted,
    duplicatesIgnored: imp.duplicates_ignored,
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: formatTimestamp(r.started_at),
      finishedAt: r.finished_at ? formatTimestamp(r.finished_at) : null,
      error: r.error ?? null,
    })),
    errors: errors.map((e) => ({ row: e.row_num, accountId: Number(e.account_id), reason: e.reason })),
  };
}
