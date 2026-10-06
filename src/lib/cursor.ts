import { validationError } from './errors.js';
export const encodeCursor = (v: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(v)).toString('base64url');
/** Opaque cursor → object. Malformed → AppError 400 VALIDATION_ERROR. Callers validate the fields they expect. */
export function decodeCursor(s: string): Record<string, unknown> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error();
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw validationError('malformed cursor');
  }
}
