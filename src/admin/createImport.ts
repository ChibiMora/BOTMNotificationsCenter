/**
 * POST /admin/notifications/imports (§3.4, §7.3, §9.4).
 *
 * Idempotency: the request hash is computed as soon as the parts are parsed and normalised, and the key is looked up in
 * `imports` before any other validation, so a genuine replay returns the original 202 even after its liveDate has
 * passed or the CSV caps have changed. Same-endpoint races are covered by the unique index on imports.request_key (the
 * duplicate-key fallback below). A key is scoped to `imports`: the same key used by a notification create or an
 * import run is a different request and is not consulted.
 */
import type Koa from 'koa';
import multer from '@koa/multer';
import type { Deps } from '../lib/deps.js';
import { differentRequest, isDuplicateKey, sha256Hex } from './idempotency.js';
import { enqueueAfterCommit } from './enqueueAfterCommit.js';
import { validationError } from '../lib/errors.js';
import { formatTimestamp, parseRequestTimestamp, truncateToSecond } from '../lib/time.js';
import { withTransaction } from '../db/index.js';
import { createImportSchema } from './schemas.js';
import { checkCsvShape } from './csvShape.js';

/** The default csvMaxBytes (10 MiB). The streaming limit never drops below it, so a replay still parses (see below). */
const DEFAULT_CSV_MAX_BYTES = 10_485_760;

/**
 * Multipart parsing for this route only: memory storage, one `file` part, one text field. The streaming limit bounds
 * memory at max(csvMaxBytes, 10 MiB); the configured csvMaxBytes itself is enforced by checkCsvShape for new keys only,
 * so a replay of an upload accepted under a since-lowered cap still returns its original 202.
 */
export const importUpload = (deps: Deps) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(deps.config.csvMaxBytes, DEFAULT_CSV_MAX_BYTES), files: 1, fields: 1 },
  }).fields([{ name: 'file', maxCount: 1 }]);

function readParts(ctx: Koa.Context): { json: string; file: Buffer } {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const files = ((ctx.request as { files?: unknown }).files ??
    (ctx as { files?: unknown }).files ??
    {}) as Record<string, Array<{ buffer: Buffer }>>;
  const fieldNames = Object.keys(body);
  if (fieldNames.length !== 1 || fieldNames[0] !== 'notification' || typeof body.notification !== 'string') {
    throw validationError('expected exactly one notification part and one file part');
  }
  const file = files.file?.[0];
  if (!file || Object.keys(files).length !== 1) throw validationError('expected exactly one file part');
  return { json: body.notification, file: file.buffer };
}

/** An import already holds this key: same hash → 202 with the stored ids (true); different hash → 400. */
async function replied(deps: Deps, ctx: Koa.Context, key: string, hash: string): Promise<boolean> {
  const existing = await deps
    .db('imports')
    .where({ request_key: key })
    .first('id', 'notification_id', 'request_hash');
  if (!existing) return false;
  if (existing.request_hash !== hash) throw differentRequest();
  ctx.status = 202;
  ctx.body = { id: existing.id, notificationId: existing.notification_id };
  return true;
}

export async function createImport(deps: Deps, ctx: Koa.Context) {
  const { json, file } = readParts(ctx);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw validationError('notification part must be valid JSON');
  }
  const body = createImportSchema.parse(raw);
  const liveDate = parseRequestTimestamp(body.liveDate, deps.config.businessTimezone);
  const key = ctx.state.idempotencyKey as string;
  // The normalised JSON part, keys in a fixed order, then the file bytes (§9.4).
  const normalised = JSON.stringify({
    image: body.image,
    headline: body.headline,
    subheadline: body.subheadline,
    link: body.link,
    liveDate: formatTimestamp(liveDate),
  });
  const hash = sha256Hex(normalised, '\n', file);
  if (await replied(deps, ctx, key, hash)) return;

  // A new key: only now validate against the current clock and caps.
  const now = truncateToSecond(deps.clock.now());
  if (liveDate.getTime() <= now.getTime()) throw validationError('liveDate must be in the future');
  const ids = await checkCsvShape(file, {
    maxBytes: deps.config.csvMaxBytes,
    maxRows: deps.config.csvMaxRows,
  });

  let created: { id: number; notificationId: number; runId: number } | undefined;
  try {
    created = await withTransaction(deps.db, async (trx) => {
      const type = await trx('notification_types').where({ name: 'csv' }).first('id');
      const [notificationId] = await trx('notifications').insert({
        type: type.id,
        image_key: body.image,
        headline: body.headline,
        subheadline: body.subheadline,
        link_path: body.link,
        active: true,
        live_date: liveDate,
        created_at: now,
      });
      const [id] = await trx('imports').insert({
        notification_id: notificationId,
        status: 'processing',
        updated_at: now,
        total_rows: ids.length,
        request_key: key,
        request_hash: hash,
        created_at: now,
      });
      const [runId] = await trx('import_runs').insert({
        import_id: id,
        status: 'processing',
        started_at: now,
      });
      await trx('import_files').insert({ import_id: id, data: file });
      return { id: id!, notificationId: notificationId!, runId: runId! };
    });
  } catch (err) {
    if (!isDuplicateKey(err, 'imports')) throw err;
  }

  if (!created) {
    if (await replied(deps, ctx, key, hash)) return;
    throw differentRequest();
  }

  // §7.3 step 3: enqueue after commit; a failed enqueue does not fail the request (housekeeping re-enqueues).
  await enqueueAfterCommit(
    deps,
    ctx,
    'process_import',
    { importId: created.id, runId: created.runId, requestId: ctx.state.requestId },
    { importId: created.id },
  );
  ctx.status = 202;
  ctx.body = { id: created.id, notificationId: created.notificationId };
}
