// knex CLI config. One connection definition: reuses createDb's config (mysql2, UTC, strict SQL mode, READ COMMITTED,
// -FOUND_ROWS) and MIGRATIONS, and reads only the database settings, as scripts/db.ts does (dbScriptSettings), so the
// CLI is not refused for unrelated application settings in production. Prefer `npm run db -- …`.
import type { Knex } from 'knex';
import { dbScriptSettings } from './scripts/db.js';
import { createDb, MIGRATIONS } from './src/db/index.js';
const urlDbName = (url: string | undefined) => {
  try {
    return url ? decodeURIComponent(new URL(url).pathname.slice(1)) : '';
  } catch {
    return '';
  }
};
const settings = dbScriptSettings(process.env, process.env.DB_NAME ?? urlDbName(process.env.DATABASE_URL));
if (!settings.ok) throw new Error(settings.message);
const probe = createDb(settings.databaseUrl);
const knexConfig: Knex.Config = { ...probe.client.config, migrations: MIGRATIONS };
await probe.destroy();
export default knexConfig;
