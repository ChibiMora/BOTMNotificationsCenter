// knex CLI config. One connection definition: reuses createDb's config (mysql2, UTC, strict SQL mode, READ COMMITTED,
// -FOUND_ROWS) and MIGRATIONS, with the same unused-URL fallbacks as scripts/db.ts. Prefer `npm run db -- …`.
import type { Knex } from 'knex';
import { loadConfig } from './src/config/index.js';
import { createDb, MIGRATIONS } from './src/db/index.js';
const config = loadConfig({
  ASSET_BASE_URL: 'http://unused.invalid',
  SITE_BASE_URL: 'http://unused.invalid',
  ...process.env,
});
const probe = createDb(config.databaseUrl);
const knexConfig: Knex.Config = { ...probe.client.config, migrations: MIGRATIONS };
await probe.destroy();
export default knexConfig;
