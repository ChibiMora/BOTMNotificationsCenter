/** Shared query (§7.2, §8.2–8.3): active, non-removed notifications of type filter, aliased `n`, joined to `t`. */
import type { Knex } from 'knex';

export const activeFilterNotifications = (db: Knex): Knex.QueryBuilder =>
  db('notifications as n')
    .join('notification_types as t', 't.id', 'n.type')
    .where({ 't.name': 'filter', 'n.active': true, 'n.removed': false });
