import { describe, it, expect } from 'vitest';
import { validatePath, toUrl } from '../../src/lib/urls.js';
describe('paths', () => {
  it('valid path kept and composed', () => {
    expect(validatePath('/images/a-b_c.png')).toBe(true);
    expect(toUrl('https://assets.example.com', '/images/a.png')).toBe(
      'https://assets.example.com/images/a.png',
    );
    expect(toUrl('https://assets.example.com/', '/images/a.png')).toBe(
      'https://assets.example.com/images/a.png',
    );
  });
  it('accepts paths the rule allows', () => {
    for (const p of [
      '/',
      '/a/',
      '/.well-known/x',
      '/a/.../b',
      '/a%2eb',
      '/a:b',
      '/a%20b',
      '/img/promo.png',
      '/books/fall-picks',
    ])
      expect(validatePath(p), JSON.stringify(p)).toBe(true);
  });
  it('rejects', () => {
    for (const p of [
      'https://evil.com/x',
      'http:/x',
      '//evil.com/x',
      '/\\evil.com',
      '/a?b=1',
      '/a#f',
      '/a/../b',
      '/..',
      '/a b',
      '/a\tb',
      '/a\u0000b',
      '/a\u007fb',
      'a/b',
      '',
      '/a//b',
      '/%2e%2e/x',
      '/a/%2E%2E/b',
      '/a/.%2e/b',
      '/a/%2e./b',
      '/a/%2e/b',
      '/a/./b',
      '/./x',
      '/a/.',
      '/a\u200bb',
      '/a\u202eb',
      '/a\ufeffb',
    ])
      expect(validatePath(p), JSON.stringify(p)).toBe(false);
  });
});
