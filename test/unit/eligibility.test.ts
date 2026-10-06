// Eligibility query builder (§6.4, B7): asserted on the SQL and bindings knex builds; no database connection.
import { describe, it, expect, afterAll } from 'vitest';
import knex from 'knex';
import { eligibleAccounts } from '../../src/eligibility/buildQuery.js';

const db = knex({ client: 'mysql2' });
afterAll(() => db.destroy());
const sql = (filters: Record<string, unknown>) => eligibleAccounts(db, filters).toSQL();

describe('eligibleAccounts', () => {
  it('no filters matches everyone: a bare select of accounts.id', () => {
    expect(sql({})).toMatchObject({ sql: 'select `accounts`.`id` from `accounts`', bindings: [] });
  });
  it('country alone', () => {
    expect(sql({ country: ['CA'] })).toMatchObject({
      sql: 'select `accounts`.`id` from `accounts` where `accounts`.`country` in (?)',
      bindings: ['CA'],
    });
  });
  it('policy alone', () => {
    expect(sql({ policy: ['monthly', 'annual'] })).toMatchObject({
      sql: 'select `accounts`.`id` from `accounts` where `accounts`.`policy` in (?, ?)',
      bindings: ['monthly', 'annual'],
    });
  });
  it('relationship status alone, mapped to stored values', () => {
    expect(sql({ relationshipStatus: ['newMember', 'friend', 'bff'] })).toMatchObject({
      sql: 'select `accounts`.`id` from `accounts` where `accounts`.`relationship_status` in (?, ?, ?)',
      bindings: ['new_member', 'friend', 'bff'],
    });
  });
  it('credits minimum alone is inclusive', () => {
    expect(sql({ credits: { minimum: 2 } })).toMatchObject({
      sql: 'select `accounts`.`id` from `accounts` where `accounts`.`credits` >= ?',
      bindings: [2],
    });
  });
  it('credits maximum alone is inclusive', () => {
    expect(sql({ credits: { maximum: 3 } })).toMatchObject({
      sql: 'select `accounts`.`id` from `accounts` where `accounts`.`credits` <= ?',
      bindings: [3],
    });
  });
  it('all filters combined, in §6.4 order', () => {
    const f = {
      country: ['US'],
      policy: ['annual'],
      relationshipStatus: ['newMember'],
      credits: { minimum: 0, maximum: 0 },
    };
    expect(sql(f)).toMatchObject({
      sql:
        'select `accounts`.`id` from `accounts` where `accounts`.`country` in (?) and `accounts`.`policy` in (?)' +
        ' and `accounts`.`relationship_status` in (?) and `accounts`.`credits` >= ? and `accounts`.`credits` <= ?',
      bindings: ['US', 'annual', 'new_member', 0, 0],
    });
  });
});

describe('eligibleAccounts: empty arrays and unusable filters', () => {
  it('an empty array imposes no constraint, exactly like an absent key', () => {
    // Compared on sql + bindings: toSQL() also carries a per-query uid.
    const sb = (f: Record<string, unknown>) => (({ sql: s, bindings }) => ({ sql: s, bindings }))(sql(f));
    const bare = sb({});
    expect(sb({ country: [] })).toEqual(bare);
    expect(sb({ country: [], policy: [], relationshipStatus: [] })).toEqual(bare);
    expect(sb({ country: [], policy: ['annual'] })).toEqual(sb({ policy: ['annual'] }));
  });
  it.each([
    ['a JSON string', '{"country":["US"]}'],
    ['a number', 7],
    ['null', null],
    ['an array', []],
    ['undefined', undefined],
  ])('fails closed on a non-object filters value (%s)', (_label, value) => {
    expect(() => eligibleAccounts(db, value as never)).toThrow(/unusable filters/);
  });
  it.each([
    ['a prototype key', { relationshipStatus: ['toString'] }],
    ['an unknown country', { country: ['MX'] }],
    ['a stored spelling for an API value', { relationshipStatus: ['new_member'] }],
    ['a non-string value', { policy: [1] }],
    ['a non-array country', { country: 'US' }],
    ['a non-array policy', { policy: { 0: 'monthly' } }],
    ['a non-object credits', { credits: 3 }],
    ['a fractional minimum', { credits: { minimum: 1.5 } }],
    ['a string maximum', { credits: { maximum: '3' } }],
  ])('throws a clear error on %s', (_label, value) => {
    expect(() => eligibleAccounts(db, value as never)).toThrow(/unusable filters/);
  });
});
