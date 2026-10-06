/** Unit: the one sorted-key JSON serialiser (request hashes and trigger bundle keys); output is pinned byte for byte. */
import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/lib/canonicalJson.js';

describe('canonicalJson', () => {
  it('sorts keys at every level, drops undefined members, keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' }, u: undefined, n: null })).toBe(
      '{"a":{"c":"x","d":[3,1]},"b":1,"n":null}',
    );
  });
  it('serialises scalars like JSON.stringify', () => {
    expect(canonicalJson('é"')).toBe(JSON.stringify('é"'));
    expect(canonicalJson(true)).toBe('true');
  });
});
