/** Unit tests for the PATCH /admin/notifications/:id body schema (§3.4). */
import { describe, it, expect } from 'vitest';
import { updateNotificationSchema } from '../../src/admin/schemas.js';

describe('updateNotificationSchema', () => {
  it('accepts exactly one of isActive (boolean) or isRemoved (literal true)', () => {
    expect(updateNotificationSchema.parse({ isActive: true })).toEqual({ isActive: true });
    expect(updateNotificationSchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(updateNotificationSchema.parse({ isRemoved: true })).toEqual({ isRemoved: true });
  });

  it.each([
    ['both keys', { isActive: true, isRemoved: true }],
    ['both keys, isActive false', { isActive: false, isRemoved: true }],
    ['neither', {}],
    ['extra key', { isActive: true, x: 1 }],
    ['extra key with isRemoved', { isRemoved: true, x: 1 }],
    ['isRemoved false', { isRemoved: false }],
    ['isRemoved "true"', { isRemoved: 'true' }],
    ['isRemoved 1', { isRemoved: 1 }],
    ['isActive "true"', { isActive: 'true' }],
    ['isActive null', { isActive: null }],
    ['isActive 0', { isActive: 0 }],
    ['an array', [{ isActive: true }]],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'isActive'],
  ])('rejects %s', (_name, body) => {
    expect(updateNotificationSchema.safeParse(body).success).toBe(false);
  });
});
