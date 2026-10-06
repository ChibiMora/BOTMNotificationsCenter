/** Unit: member zod schemas (params, list query, cursor, PATCH body). */
import { describe, it, expect } from 'vitest';
import { idParams, listQuery, listCursor, patchBody } from '../../src/member/schemas.js';

describe('member schemas', () => {
  it('idParams accepts any string id (never shape-validated)', () => {
    for (const id of ['dl_abc', 'abc', '', '../x', '123']) expect(idParams.parse({ id })).toEqual({ id });
  });
  it('listQuery: defaults, clamps, accepts a cursor', () => {
    expect(listQuery.parse({})).toEqual({ limit: 25 });
    expect(listQuery.parse({ limit: '1' })).toEqual({ limit: 1 });
    expect(listQuery.parse({ limit: '25' })).toEqual({ limit: 25 });
    expect(listQuery.parse({ limit: '100' })).toEqual({ limit: 25 });
    expect(listQuery.parse({ cursor: 'abc' })).toEqual({
      limit: 25,
      cursor: 'abc',
    });
  });
  it.each([
    { limit: '0' },
    { limit: '-1' },
    { limit: '1.5' },
    { limit: 'abc' },
    { limit: '' },
    { limit: ['1', '2'] },
    { cursor: ['a', 'b'] },
    { foo: '1' },
  ])('listQuery rejects %j', (q) => {
    expect(listQuery.safeParse(q).success).toBe(false);
  });
  it('listCursor requires exactly a timestamp s and a string p', () => {
    expect(listCursor.parse({ s: '2026-10-02T00:00:00Z', p: 'dl_abcdefghi-_Z' })).toEqual({
      s: '2026-10-02T00:00:00Z',
      p: 'dl_abcdefghi-_Z',
    });
    for (const c of [
      {},
      { s: 'nope', p: 'x' },
      { s: '2026-10-02T00:00:00Z' },
      { s: '2026-10-02T00:00:00Z', p: 1 },
      { s: '2026-10-02T00:00:00Z', p: 'x', i: 1 },
    ]) {
      expect(listCursor.safeParse(c).success).toBe(false);
    }
  });
  it.each([
    ['non-ASCII 14-char (too short) p', { s: '2026-10-02T00:00:00Z', p: 'dl_bbbbbbbbbbé' }],
    ['emoji p', { s: '2026-10-02T00:00:00Z', p: '\u{1F600}' }],
    ['too-short p', { s: '2026-10-02T00:00:00Z', p: 'dl_x' }],
    ['14-char p', { s: '2026-10-02T00:00:00Z', p: 'dl_abcdefghijk' }],
    ['too-long p', { s: '2026-10-02T00:00:00Z', p: 'dl_abcdefghijklm' }],
    ['p with a space', { s: '2026-10-02T00:00:00Z', p: 'dl_abcdefghijk ' }],
    ['fractional s', { s: '2026-10-02T00:00:00.500Z', p: 'dl_abcdefghijkl' }],
    ['offset s', { s: '2026-10-02T00:00:00+02:00', p: 'dl_abcdefghijkl' }],
    ['non-date s', { s: 'yesterday', p: 'dl_abcdefghijkl' }],
  ])('listCursor rejects %s', (_name, c) => {
    expect(listCursor.safeParse(c).success).toBe(false);
  });
  // Exactly 15 UTF-16 units, so only the printable-ASCII character check can reject them.
  it.each([
    ['non-ASCII 15-char p (ends in é)', 'dl_bbbbbbbbbbbé'],
    ['non-ASCII 15-unit p (ends in an emoji)', 'dl_bbbbbbbbbb\u{1F600}'],
  ])('listCursor rejects %s', (_name, p) => {
    expect(p.length).toBe(15);
    expect(listCursor.safeParse({ s: '2026-10-02T00:00:00Z', p }).success).toBe(false);
  });
  it('patchBody accepts only { isClicked: true }', () => {
    expect(patchBody.parse({ isClicked: true })).toEqual({ isClicked: true });
    for (const b of [
      {},
      { isClicked: false },
      { isClicked: 'true' },
      { isClicked: 1 },
      { isClicked: null },
      { isClicked: true, x: 1 },
      [true],
      null,
      'x',
    ]) {
      expect(patchBody.safeParse(b).success).toBe(false);
    }
  });
});
