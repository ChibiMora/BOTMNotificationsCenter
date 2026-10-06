// `expiry` timer (§8.3): archive live deliveries that have left the member window (B2, B16), within a daily row
// budget, one transaction per batch. Copy and delete share the batch's transaction, so a row is always in exactly one
// of the two tables.
//
// Locking: candidates are picked with a NON-locking read in `idx_due_send` order (sent_at, due_at, id: oldest first,
// served by the index, so no scan or sort of the whole backlog), then only those candidates are locked by primary key
// with FOR UPDATE SKIP LOCKED, and exactly the locked ids are copied and deleted. A batch therefore locks only its own
// rows, and an overlapping run (leader change) skips them and moves other rows. Because the moved rows are locked and
// copy + delete are atomic, a duplicate archive id can never come from overlap: the copy is a plain INSERT, so an
// anomalous pre-existing archive row (manual restore, id reuse) fails the batch loudly instead of being silently kept.
//
// Account deletion cascades (ON DELETE CASCADE) into notification_deliveries and takes its row locks in the opposite
// order to an expiry batch, so the two can deadlock; InnoDB then rolls one back. The external account deleter must
// retry on deadlock (ER_LOCK_DEADLOCK); an expiry batch that loses fails the run, and the next run retries. Batches are
// kept short and lock only their own rows to make this rare.
import type { Knex } from 'knex';
import type { Deps } from '../lib/deps.js';
import type { Timer } from './index.js';
import { cronSchedule } from './schedule.js';
import { withTransaction } from '../db/index.js';
import { truncateToSecond, windowStart } from '../lib/time.js';

const COPIED = [
  'id',
  'public_id',
  'notification_id',
  'account_id',
  'is_clicked',
  'sent_at',
  'due_at',
  'occurrence_key',
  'dedupe_key',
  'created_at',
] as const;
const COLUMN_LIST = COPIED.join(', ');

/** Non-locking candidate read: the oldest `limit` expired live deliveries, in `idx_due_send` order. */
export const expiryCandidates = (db: Knex | Knex.Transaction, cutoff: Date, limit: number) =>
  db('notification_deliveries')
    .select('id')
    .whereNotNull('sent_at')
    .where('sent_at', '<', cutoff)
    .orderBy([{ column: 'sent_at' }, { column: 'due_at' }, { column: 'id' }])
    .limit(limit);

/**
 * Lock step: of `candidates`, the still-expired ids not held by another run, locked by primary key. FORCE INDEX pins
 * the plan: with a backlog close to the batch size the optimizer may otherwise pick a skip scan on a secondary index,
 * which locks index ranges beyond the batch's own rows.
 */
export const expiryLockStep = (trx: Knex.Transaction, candidates: number[], cutoff: Date) =>
  trx
    .from(trx.raw('?? FORCE INDEX (PRIMARY)', ['notification_deliveries']))
    .whereIn('id', candidates)
    .whereNotNull('sent_at')
    .where('sent_at', '<', cutoff)
    .forUpdate()
    .skipLocked()
    .pluck('id');

/** One batch: locks the still-expired candidates not held by another run, moves exactly those. Returns rows moved. */
async function moveBatch(trx: Knex.Transaction, candidates: number[], cutoff: Date, archivedAt: Date) {
  const ids: number[] = await expiryLockStep(trx, candidates, cutoff);
  if (ids.length === 0) return 0;
  const [inserted] = await trx.raw(
    `INSERT INTO archived_notification_deliveries (${COLUMN_LIST}, archived_at)
     SELECT ${COLUMN_LIST}, ? FROM notification_deliveries WHERE id IN (?)`,
    [archivedAt, ids],
  );
  const deleted = await trx('notification_deliveries').whereIn('id', ids).delete();
  if (inserted.affectedRows !== ids.length || deleted !== ids.length) {
    throw new Error(
      `expiry batch mismatch: locked ${ids.length}, archived ${inserted.affectedRows}, deleted ${deleted}`,
    );
  }
  return deleted;
}

/** One run: archives up to `expiryDailyRowBudget` expired live deliveries in batches of `expiryBatch`. Returns the count. */
export async function expire(deps: Deps): Promise<number> {
  const { db, clock, config, log, metrics } = deps;
  const now = clock.now();
  const cutoff = windowStart(now);
  const archivedAt = truncateToSecond(now);
  let archived = 0;
  // Why the run stopped: drained (short or empty candidate read), budget (daily budget reached), contended (a full
  // candidate read locked nothing: another run holds every candidate). budget and contended leave work for later.
  let stopReason: 'drained' | 'budget' | 'contended' = 'budget';
  while (archived < config.expiryDailyRowBudget) {
    const limit = Math.min(config.expiryBatch, config.expiryDailyRowBudget - archived);
    const candidates: number[] = (await expiryCandidates(db, cutoff, limit)).map((r: { id: number }) => r.id);
    if (candidates.length === 0) {
      stopReason = 'drained';
      break;
    }
    const moved = await withTransaction(db, (trx) => moveBatch(trx, candidates, cutoff, archivedAt));
    archived += moved;
    if (moved > 0) metrics.count('expiry_rows_archived', moved);
    // Short candidate read: the backlog is drained. Zero moved from a full read: another run holds every candidate,
    // so stop rather than spin; the next run retries.
    if (candidates.length < limit) {
      stopReason = 'drained';
      break;
    }
    if (moved === 0) {
      stopReason = 'contended';
      break;
    }
  }
  metrics.count('expiry_run_stopped', 1, { reason: stopReason });
  log[stopReason === 'drained' ? 'info' : 'warn']({ archived, stopReason }, 'expiry run complete');
  return archived;
}

/** Leader only; EXPIRY_CRON. */
export const expiryTimer = (deps: Deps): Timer => ({
  name: 'expiry',
  leaderOnly: true,
  schedule: cronSchedule(deps.config.expiryCron),
  run: async (d) => {
    await expire(d);
  },
});
