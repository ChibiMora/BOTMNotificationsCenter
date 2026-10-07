/** Unit tests for the admin request schemas and the headline/subheadline sanitizer (§9.2, §3.3). */
import { describe, it, expect } from 'vitest';
import {
  plainText,
  pathField,
  filtersSchema,
  createFilterSchema,
  createEventSchema,
  listQuerySchema,
  idParamSchema,
} from '../../src/admin/schemas.js';

const content = { image: '/img/a.png', headline: 'H', subheadline: 'S', link: '/books/x' };

describe('plainText sanitizer', () => {
  const s = plainText('headline');
  it('trims and accepts punctuation and non-Latin text', () => {
    expect(s.parse('  Hello, world! & "quotes" — 100%  ')).toBe('Hello, world! & "quotes" — 100%');
    expect(s.parse('日本語のお知らせ 📚')).toBe('日本語のお知らせ 📚');
    expect(s.parse('x'.repeat(255))).toHaveLength(255);
  });
  it.each([
    ['<script>alert(1)</script>'],
    ['a < b'],
    ['a > b'],
    ['line\nbreak'],
    ['tab\there'],
    ['rtl‮override'],
    ['iso⁦late'],
    ['   '],
    [''],
    ['x'.repeat(256)],
  ])('rejects %j', (v) => {
    expect(s.safeParse(v).success).toBe(false);
  });
});

describe('pathField', () => {
  const p = pathField('link', 2048);
  it('accepts a relative path', () => expect(p.parse('/books/fall-picks')).toBe('/books/fall-picks'));
  it.each([
    'https://x.com/a',
    '//host/a',
    '/a\\b',
    '/a?b=1',
    '/a#f',
    '/a/../b',
    'a/b',
    '/' + 'a'.repeat(2048),
  ])('rejects %j', (v) => expect(p.safeParse(v).success).toBe(false));
});

describe('filtersSchema', () => {
  it('dedupes, drops empty arrays, keeps credits', () => {
    expect(filtersSchema.parse({ country: ['CA', 'CA'], policy: [], credits: { minimum: 1 } })).toEqual({
      country: ['CA'],
      credits: { minimum: 1 },
    });
    expect(filtersSchema.parse({})).toEqual({});
  });
  it.each([
    { country: ['MX'] },
    { policy: ['weekly'] },
    { relationshipStatus: ['enemy'] },
    { credits: { minimum: 3, maximum: 2 } },
    { credits: { minimum: -1 } },
    { credits: { maximum: 1.5 } },
    { credits: { other: 1 } },
    { extra: 1 },
    { country: 'US' },
  ])('rejects %j', (v) => expect(filtersSchema.safeParse(v).success).toBe(false));
});

describe('create schemas', () => {
  it('filter requires isActive', () => {
    expect(createFilterSchema.safeParse(content).success).toBe(false);
    expect(createFilterSchema.parse({ ...content, isActive: false })).toEqual({
      ...content,
      isActive: false,
    });
    expect(createFilterSchema.safeParse({ ...content, isActive: true, x: 1 }).success).toBe(false);
  });
  it('event validates trigger and delay', () => {
    for (const t of ['shipped', 'enrolled', 'preenrollAudiobook']) {
      expect(createEventSchema.safeParse({ ...content, isActive: true, eventTrigger: t }).success).toBe(true);
    }
    for (const bad of [
      { eventTrigger: 'x' },
      { eventTrigger: 'shipped', delay: -1 },
      { eventTrigger: 'shipped', delay: 366 },
      { eventTrigger: 'shipped', delay: 1.5 },
    ]) {
      expect(createEventSchema.safeParse({ ...content, isActive: true, ...bad }).success).toBe(false);
    }
  });
});

describe('listQuerySchema and idParamSchema', () => {
  it('clamps limit and rejects bad values', () => {
    expect(listQuerySchema.parse({ limit: '100' }).limit).toBe(25);
    for (const q of [
      { limit: '0' },
      { limit: '-1' },
      { limit: '1.5' },
      { limit: ['1', '2'] },
      { type: 'x' },
      { foo: '1' },
    ]) {
      expect(listQuerySchema.safeParse(q).success).toBe(false);
    }
  });
  it('id must be a positive integer', () => {
    expect(idParamSchema.parse('42')).toBe(42);
    for (const v of ['0', '-1', 'abc', '1.5', '99999999999'])
      expect(idParamSchema.safeParse(v).success).toBe(false);
  });
});

describe('plainText: separators, override-range ends, ill-formed strings, astral length', () => {
  const s = plainText('headline');
  it.each([
    ['x\u2028y'],
    ['x\u2029y'],
    ['a\u202ab'],
    ['a\u202eb'],
    ['a\u2066b'],
    ['a\u2069b'],
    ['\ud800x'],
    ['x\udc00'],
  ])('rejects %j', (v) => {
    expect(s.safeParse(v).success).toBe(false);
  });
  it.each([['a‧b'], ['a b'], ['a⁥b'], ['a⁪b']])(
    'accepts %j (just outside the rejected ranges, not a control character)',
    (v) => {
      expect(s.parse(v)).toBe(v);
    },
  );
  it('255 astral characters accepted unchanged, 256 rejected', () => {
    const e = '📚'.repeat(255);
    expect(s.parse(e)).toBe(e);
    expect(s.safeParse('📚'.repeat(256)).success).toBe(false);
  });
});

describe('pathField: ill-formed strings', () => {
  it('rejects a lone surrogate', () => {
    expect(pathField('link', 2048).safeParse('/books/\ud800x').success).toBe(false);
    expect(pathField('image', 1024).safeParse('/img/\udc00.png').success).toBe(false);
  });
});

describe('filtersSchema: credits upper bound', () => {
  it('accepts 2147483647, rejects above it and 1e300', () => {
    expect(filtersSchema.parse({ credits: { minimum: 2147483647, maximum: 2147483647 } })).toEqual({
      credits: { minimum: 2147483647, maximum: 2147483647 },
    });
    for (const v of [2147483648, 1e300]) {
      expect(filtersSchema.safeParse({ credits: { minimum: v } }).success).toBe(false);
      expect(filtersSchema.safeParse({ credits: { maximum: v } }).success).toBe(false);
    }
  });
});

describe('createEventSchema: delay null', () => {
  it('rejects delay: null (null is only a response value)', () => {
    const b = { ...content, isActive: true, eventTrigger: 'shipped' };
    expect(createEventSchema.safeParse({ ...b, delay: null }).success).toBe(false);
  });
});
