/** Accounts adapter (§6.4): the accounts table's name, its four filter columns and the API → stored value maps. */
export const ACCOUNTS_TABLE = 'accounts';

export const ACCOUNT_COLUMNS = {
  id: 'id',
  country: 'country',
  policy: 'policy',
  relationshipStatus: 'relationship_status',
  credits: 'credits',
} as const;

/** API value → stored value, per filter key. A value missing from a map is unusable (eligibleAccounts throws). */
export const COUNTRY_VALUES: Readonly<Record<string, string>> = { US: 'US', CA: 'CA' };
export const POLICY_VALUES: Readonly<Record<string, string>> = { monthly: 'monthly', annual: 'annual' };
export const RELATIONSHIP_STATUS_VALUES: Readonly<Record<string, string>> = {
  newMember: 'new_member',
  friend: 'friend',
  bff: 'bff',
};

/** Qualified column name, e.g. `accounts.credits`. */
export const accountColumn = (key: keyof typeof ACCOUNT_COLUMNS) =>
  `${ACCOUNTS_TABLE}.${ACCOUNT_COLUMNS[key]}`;
