// `process_import` job handler (§7.3 steps 5–9, §8.2) and its dead-letter hook.
import type { Deps } from '../lib/deps.js';
import type { JobContext, JobPayloads } from '../queue/queue.js';
import { insertDeliveries } from '../lib/insertDeliveries.js';
import { truncateToSecond } from '../lib/time.js';
import { withTransaction } from '../db/index.js';
import { readAccountIds } from '../lib/csvAccountIds.js';
import { ACCOUNTS_TABLE, ACCOUNT_COLUMNS } from '../eligibility/accountsSchema.js';

/** accounts.id is INT UNSIGNED: a larger id cannot exist, so it is never looked up. */
const MAX_ACCOUNT_ID = 4294967295;
const ERROR_BATCH = 1000;

/** Data-row ids of a stored file, in order, read exactly as the upload check read them. */
async function storedIds(data: Buffer): Promise<number[]> {
  const ids: number[] = [];
  for await (const { id } of readAccountIds(data)) ids.push(id);
  return ids;
}

type FailReason = 'removed' | 'dead' | 'file_missing';

/**
 * Marks the run (only while still processing) and the import failed. Returns whether this call moved the run from
 * `processing` to `failed`; only then is `process_import_failed` counted and the ending logged at warn (ids and reason
 * only).
 */
async function failRun(
  deps: Deps,
  importId: number,
  runId: number,
  reason: FailReason,
  error: string,
  deleteFile: boolean,
): Promise<boolean> {
  const now = truncateToSecond(deps.clock.now());
  const changed = await withTransaction(deps.db, async (trx) => {
    const n = await trx('import_runs')
      .where({ id: runId, import_id: importId, status: 'processing' })
      .update({ status: 'failed', finished_at: now, error: error.slice(0, 255) });
    if (n !== 1) return false;
    await trx('imports').where({ id: importId }).update({ status: 'failed', updated_at: now });
    if (deleteFile) await trx('import_files').where({ import_id: importId }).delete();
    return true;
  });
  if (changed) {
    deps.metrics.count('process_import_failed', 1, { reason });
    deps.log.warn({ importId, runId, reason }, 'process_import failed');
  }
  return changed;
}

/** MUST touch `imports.updated_at` after every chunk (housekeeping re-enqueues imports idle for 10 minutes). */
export const processImport: (
  deps: Deps,
  payload: JobPayloads['process_import'],
  ctx: JobContext,
) => Promise<void> = async (deps, { importId, runId }, ctx) => {
  const run = await deps.db('import_runs').where({ id: runId, import_id: importId }).first('status');
  if (!run || run.status !== 'processing') return;
  const imp = await deps.db('imports').where({ id: importId }).first('notification_id');
  const file = await deps.db('import_files').where({ import_id: importId }).first('data');
  if (!imp || !file) {
    await failRun(deps, importId, runId, 'file_missing', 'import file missing', false);
    return;
  }
  const rows = await storedIds(file.data as Buffer);
  const firstRow = new Map<number, number>(); // distinct id -> first 1-based data-row number
  rows.forEach((id, i) => {
    if (!firstRow.has(id)) firstRow.set(id, i + 1);
  });
  const distinct = [...firstRow.keys()];

  let accepted = 0;
  let deliveriesInserted = 0;
  const errors: Array<{ row: number; accountId: number }> = [];
  for (let i = 0; i < distinct.length; i += deps.config.importChunk) {
    const n = await deps.db('notifications').where({ id: imp.notification_id }).first('removed', 'live_date');
    if (!n || n.removed) {
      await failRun(deps, importId, runId, 'removed', 'notification removed', true);
      return;
    }
    const chunk = distinct.slice(i, i + deps.config.importChunk);
    const lookup = chunk.filter((id) => id <= MAX_ACCOUNT_ID);
    const found: number[] = lookup.length
      ? (await deps.db(ACCOUNTS_TABLE).whereIn(ACCOUNT_COLUMNS.id, lookup).pluck(ACCOUNT_COLUMNS.id)).map(
          Number,
        )
      : [];
    const now = deps.clock.now();
    const liveDate = new Date(n.live_date);
    const live = liveDate.getTime() <= now.getTime();
    const result = await insertDeliveries(
      deps.db,
      found.map((accountId) => ({
        notificationId: imp.notification_id,
        accountId,
        dedupeKey: 'import',
        dueAt: liveDate,
        ...(live ? { sentAt: now } : {}),
      })),
      { now },
    );
    deliveriesInserted += result.inserted;
    const exists = new Set(found);
    for (const id of result.unknownAccounts) exists.delete(id);
    accepted += exists.size;
    for (const id of chunk) if (!exists.has(id)) errors.push({ row: firstRow.get(id)!, accountId: id });
    await deps
      .db('imports')
      .where({ id: importId })
      .update({ updated_at: truncateToSecond(deps.clock.now()) });
    await ctx.heartbeat();
  }

  errors.sort((a, b) => a.row - b.row);
  const now = truncateToSecond(deps.clock.now());
  const completed = await withTransaction(deps.db, async (trx) => {
    // Guard: only a run still processing completes; a concurrent duplicate of this job waits here, then no-ops.
    const changed = await trx('import_runs')
      .where({ id: runId, import_id: importId, status: 'processing' })
      .update({ status: 'completed', finished_at: now });
    if (changed !== 1) return false;
    // Error rows left by a previous attempt are replaced inside the same guarded transaction.
    await trx('import_row_errors').where({ import_id: importId }).delete();
    for (let i = 0; i < errors.length; i += ERROR_BATCH) {
      await trx('import_row_errors').insert(
        errors.slice(i, i + ERROR_BATCH).map((e) => ({
          import_id: importId,
          row_num: e.row,
          account_id: e.accountId,
          reason: 'UNKNOWN_ACCOUNT',
        })),
      );
    }
    await trx('imports')
      .where({ id: importId })
      .update({
        status: 'completed',
        accepted,
        duplicates_ignored: rows.length - distinct.length,
        updated_at: now,
      });
    await trx('import_files').where({ import_id: importId }).delete();
    return true;
  });
  deps.metrics.count('process_import_deliveries_written', deliveriesInserted);
  if (!completed) return;
  deps.metrics.count('process_import_unknown_accounts', errors.length);
  deps.metrics.count('process_import_completed');
  // Ids and counts only: never account lists or content.
  deps.log.info(
    {
      importId,
      runId,
      accepted,
      duplicatesIgnored: rows.length - distinct.length,
      errors: errors.length,
      deliveriesInserted,
    },
    'process_import completed',
  );
};

/** Dead-letter hook: marks the run and the import failed and keeps the file so a new run can retry. Never throws. */
export const onProcessImportDead: (
  deps: Deps,
  payload: JobPayloads['process_import'],
  error: Error,
) => Promise<void> = async (deps, { importId, runId }) => {
  try {
    await failRun(deps, importId, runId, 'dead', 'processing failed after the last attempt', false);
  } catch (err) {
    deps.log.error({ err, importId, runId }, 'process_import dead-letter update failed');
  }
};
