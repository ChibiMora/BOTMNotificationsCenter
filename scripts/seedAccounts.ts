// STAND-IN seed (§5.9). Order: country (US, CA) × policy (monthly, annual) × status (new_member, friend, bff) × credits
// (0,1,2,3,5,10), credits varying fastest. id = 1 + index: 1 = US/monthly/new_member/0, 6 = …/10, 7 = US/monthly/friend/0, 72 = CA/annual/bff/10.
import type { Knex } from 'knex';
import type { Config } from '../src/config/index.js';
export const SEED_ACCOUNTS = ['US', 'CA']
  .flatMap((country) =>
    ['monthly', 'annual'].flatMap((policy) =>
      ['new_member', 'friend', 'bff'].flatMap((relationship_status) =>
        [0, 1, 2, 3, 5, 10].map((credits) => ({ country, policy, relationship_status, credits })),
      ),
    ),
  )
  .map((a, i) => ({ id: i + 1, ...a }));
/** Idempotent; skipped unless STANDINS=true. Resets ids 1–72 to their documented attributes. */
export async function seedAccounts(db: Knex, config: Config) {
  if (!config.standins) return false;
  await db('accounts')
    .insert(SEED_ACCOUNTS)
    .onConflict('id')
    .merge(['country', 'policy', 'relationship_status', 'credits']);
  return true;
}
