/** Defaults for the DB test projects when unset (§10.4: `docker compose up -d mysql` then `npm test`). Explicit env wins. */
export const TEST_DB_DEFAULTS = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://root:root@127.0.0.1:3306/notification_center',
  DB_NAME: process.env.DB_NAME ?? 'notification_center_test',
};
