/**
 * Idempotency-Key checks shared by every admin create (§9.4): one message, one duplicate test. A key identifies a
 * request within one table's request_key column; the same key in another table is a different request.
 */
import { createHash } from 'node:crypto';
import { validationError } from '../lib/errors.js';
import { canonicalJson } from '../lib/canonicalJson.js';

/** The three tables that store a request_key, each with its own unique index. */
export type KeyTable = 'notifications' | 'imports' | 'import_runs';
const UNIQUE_INDEX: Record<KeyTable, string> = {
  notifications: 'uq_notifications_request_key',
  imports: 'uq_imports_request_key',
  import_runs: 'uq_import_runs_request_key',
};

/** The 400 for a key reused in the same table with a different request (or by the other endpoint sharing it). */
export const differentRequest = () => validationError('Idempotency-Key already used for a different request');

/** True for a MySQL duplicate (`ER_DUP_ENTRY`) on `table`'s request_key unique index; any other duplicate is not. */
export function isDuplicateKey(err: unknown, table: KeyTable): boolean {
  const e = err as { code?: string; message?: string; sqlMessage?: string };
  return (
    e?.code === 'ER_DUP_ENTRY' && `${e.message ?? ''} ${e.sqlMessage ?? ''}`.includes(UNIQUE_INDEX[table])
  );
}

/** sha256 hex of the concatenated parts (the stored request_hash). */
export const sha256Hex = (...parts: (string | Buffer)[]) =>
  parts.reduce((h, p) => h.update(p), createHash('sha256')).digest('hex');

/** request_hash of a JSON request: sha256 of its canonical (sorted-key) JSON. */
export const requestHash = (normalised: unknown) => sha256Hex(canonicalJson(normalised));
