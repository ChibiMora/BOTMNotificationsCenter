import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/lib/cursor.js';
import { newPublicId } from '../../src/lib/publicId.js';
import { AppError } from '../../src/lib/errors.js';
describe('cursor', () => {
  it('round trip', () => {
    const c = { createdAt: '2026-10-04T14:30:00Z', id: 7 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it('garbage → 400 VALIDATION_ERROR', () => {
    for (const s of ['!!!', 'bm90IGpzb24', Buffer.from('"str"').toString('base64url')]) {
      try {
        decodeCursor(s);
        expect.fail('no throw');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).status).toBe(400);
        expect((e as AppError).code).toBe('VALIDATION_ERROR');
      }
    }
  });
});
describe('public id', () => {
  it('format', () => {
    const id = newPublicId();
    expect(id).toMatch(/^dl_[A-Za-z0-9_-]{12}$/);
    expect(id).not.toBe(newPublicId());
  });
});
