/**
 * Eligibility query (§6.4, B7): one bound predicate per filter key present; `{}`, absent keys and empty arrays match
 * every account; malformed filters (unknown keys, explicit nulls, bad values) throw.
 */
import type { Knex } from 'knex';
import {
  ACCOUNTS_TABLE,
  COUNTRY_VALUES,
  POLICY_VALUES,
  RELATIONSHIP_STATUS_VALUES,
  accountColumn,
} from './accountsSchema.js';

/** A notification's stored `filters` object, as the API spells it (§5.4). */
export interface Filters {
  country?: string[];
  policy?: string[];
  relationshipStatus?: string[];
  credits?: { minimum?: number; maximum?: number };
}

/** Thrown when a stored `filters` value cannot be turned into a query; the message never carries the value. */
export class UnusableFiltersError extends Error {
  constructor(reason: string) {
    super(`unusable filters: ${reason}`);
    this.name = 'UnusableFiltersError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const FILTER_KEYS: ReadonlySet<string> = new Set(['country', 'policy', 'relationshipStatus', 'credits']);
const CREDIT_KEYS: ReadonlySet<string> = new Set(['minimum', 'maximum']);

/** Throws on any own key outside `known`: an unknown key would otherwise be dropped and widen the audience. */
function onlyKnownKeys(o: Record<string, unknown>, known: ReadonlySet<string>, where: string): void {
  if (Object.keys(o).some((k) => !known.has(k))) {
    throw new UnusableFiltersError(`${where} has an unknown key`);
  }
}

/** API values → stored values; an absent or empty array means no constraint (undefined). Throws on anything else, null included. */
function storedValues(
  f: Record<string, unknown>,
  key: string,
  map: Readonly<Record<string, string>>,
): string[] | undefined {
  const values = f[key];
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values)) {
    throw new UnusableFiltersError(`${key} is not an array`);
  }
  if (values.length === 0) {
    return undefined;
  }
  return values.map((v) => {
    if (typeof v !== 'string' || !Object.hasOwn(map, v)) {
      throw new UnusableFiltersError(`${key} has an unknown value`);
    }
    return map[v]!;
  });
}

function creditBound(credits: Record<string, unknown>, key: 'minimum' | 'maximum'): number | undefined {
  const v = credits[key];
  if (v !== undefined && !Number.isSafeInteger(v)) {
    throw new UnusableFiltersError(`credits.${key} is not a safe integer`);
  }
  return v as number | undefined;
}

/** Throws UnusableFiltersError unless `filters` is a plain object of well-formed filters (fails closed). */
export function eligibleAccounts(db: Knex, filters: unknown): Knex.QueryBuilder {
  if (!isPlainObject(filters)) {
    throw new UnusableFiltersError('not an object');
  }
  onlyKnownKeys(filters, FILTER_KEYS, 'filters');
  const country = storedValues(filters, 'country', COUNTRY_VALUES);
  const policy = storedValues(filters, 'policy', POLICY_VALUES);
  const status = storedValues(filters, 'relationshipStatus', RELATIONSHIP_STATUS_VALUES);
  // Only an absent key means no constraint; an explicit null is unusable, like any other non-object.
  const credits = filters.credits === undefined ? {} : filters.credits;
  if (!isPlainObject(credits)) {
    throw new UnusableFiltersError('credits is not an object');
  }
  onlyKnownKeys(credits, CREDIT_KEYS, 'credits');
  const minimum = creditBound(credits, 'minimum');
  const maximum = creditBound(credits, 'maximum');
  const q = db(ACCOUNTS_TABLE).select(accountColumn('id'));
  if (country) {
    q.whereIn(accountColumn('country'), country);
  }
  if (policy) {
    q.whereIn(accountColumn('policy'), policy);
  }
  if (status) {
    q.whereIn(accountColumn('relationshipStatus'), status);
  }
  if (minimum !== undefined) {
    q.where(accountColumn('credits'), '>=', minimum);
  }
  if (maximum !== undefined) {
    q.where(accountColumn('credits'), '<=', maximum);
  }
  return q;
}

/** Restricts an eligibility query to accounts not yet delivered this notification under `dedupeKey`. */
export function notYetDelivered(
  q: Knex.QueryBuilder,
  notificationId: number,
  dedupeKey: string,
): Knex.QueryBuilder {
  return q.whereNotExists(function () {
    this.select(1)
      .from('notification_deliveries')
      .whereRaw('notification_deliveries.account_id = ??', [accountColumn('id')])
      .andWhere('notification_deliveries.notification_id', notificationId)
      .andWhere('notification_deliveries.dedupe_key', dedupeKey);
  });
}

/** Restricts an eligibility query to account ids in [lo, hi]. */
export const idBetween = (q: Knex.QueryBuilder, lo: number, hi: number) =>
  q.whereBetween(accountColumn('id'), [lo, hi]);

/** Restricts an eligibility query to one account. */
export const forAccount = (q: Knex.QueryBuilder, accountId: number) =>
  q.where(accountColumn('id'), accountId);

/** Lowest account id >= `lo`, or undefined when there is none. */
export async function nextAccountId(db: Knex, lo: number): Promise<number | undefined> {
  const row = await db(ACCOUNTS_TABLE)
    .min({ m: accountColumn('id') })
    .where(accountColumn('id'), '>=', lo)
    .first();
  return row?.m == null ? undefined : Number(row.m);
}
