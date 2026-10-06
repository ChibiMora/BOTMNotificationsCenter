/** Unit: the one "not found" helper renders today's per-resource 404 bodies through the error mapper. */
import { describe, it, expect } from 'vitest';
import { notFound } from '../../src/lib/errors.js';
import { mapError } from '../../src/middleware/errorMapper.js';

describe('notFound', () => {
  it.each([
    ['notification', 'notification not found'],
    ['import', undefined],
    ['delivery', undefined],
  ] as const)('%s → 404 NOT_FOUND', (resource, message) => {
    expect(mapError(notFound(resource))).toMatchObject({ status: 404, code: 'NOT_FOUND', message });
  });
});
