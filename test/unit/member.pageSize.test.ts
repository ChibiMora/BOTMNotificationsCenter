/** Unit: the one page-size constant and `limit` schema shared by the admin and member list queries (§9.6). */
import { describe, it, expect } from 'vitest';
import { PAGE_SIZE, limitQuery, queryValue } from '../../src/lib/pageSize.js';
import { listQuery } from '../../src/member/schemas.js';
import { listQuerySchema } from '../../src/admin/schemas.js';

const msg = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.error?.issues[0]?.message;

describe('shared page size', () => {
  it('is 25, the default, and the clamp', () => {
    expect(PAGE_SIZE).toBe(25);
    expect(limitQuery.parse(undefined)).toBe(25);
    expect(limitQuery.parse('100')).toBe(25);
    expect(limitQuery.parse('3')).toBe(3);
  });
  it.each(['0', '-1', '1.5', 'x'])('rejects %s with one message', (v) => {
    expect(msg(limitQuery.safeParse(v))).toBe('limit must be a positive integer');
  });
  it('rejects a repeated value with the "given once" message', () => {
    expect(msg(queryValue('cursor').safeParse(['a', 'b']))).toBe('cursor must be given once');
  });
  it('both surfaces report identical limit and repeat messages', () => {
    for (const q of [{ limit: '0' }, { limit: ['1', '2'] }, { cursor: ['a', 'b'] }]) {
      expect(msg(listQuery.safeParse(q))).toBe(msg(listQuerySchema.safeParse(q)));
    }
    expect(listQuery.parse({}).limit).toBe(PAGE_SIZE);
    expect(listQuerySchema.parse({}).limit).toBe(PAGE_SIZE);
  });
});
