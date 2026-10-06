// db create|migrate|drop <name>   (dev: `npm run db -- …`; image release step: `node dist/scripts/db.js migrate <name>`).
// create = create + migrate + seed stand-in accounts (STANDINS=true); migrate = migrate only; drop = drop. Reserved schemas refused.
// Reads only DATABASE_URL (its database replaced by <name>; DB_NAME is ignored), STANDINS and NODE_ENV — never the whole
// application config, so a production release step needs nothing but the database settings.
import { isMainModule } from '../src/lib/mainModule.js';
import type { Config } from '../src/config/index.js';
import { createDb, MIGRATIONS } from '../src/db/index.js';
import { seedAccounts } from './seedAccounts.js';
const COMMANDS = ['create', 'migrate', 'drop'] as const;
type Command = (typeof COMMANDS)[number];
const RESERVED = ['mysql', 'sys', 'information_schema', 'performance_schema'];
export type DbCommandCheck =
  { ok: true; cmd: Command; name: string } | { ok: false; reason: 'usage' | 'reserved'; message: string };
/** Pure guard for the CLI arguments: a known command, a [A-Za-z0-9_]+ name, never a reserved system schema. */
export function checkDbCommand(cmd: string | undefined, name: string | undefined): DbCommandCheck {
  if (!COMMANDS.includes(cmd as Command) || !name || !/^[A-Za-z0-9_]+$/.test(name))
    return {
      ok: false,
      reason: 'usage',
      message: 'usage: db create|migrate|drop <name>   (name: [A-Za-z0-9_]+)',
    };
  if (RESERVED.includes(name.toLowerCase()))
    return { ok: false, reason: 'reserved', message: `refusing to ${cmd} reserved schema ${name}` };
  return { ok: true, cmd: cmd as Command, name };
}
export type DbScriptSettings =
  { ok: true; databaseUrl: string; serverUrl: string; seed: boolean } | { ok: false; message: string };
/** Pure: the database settings the script needs. Stand-ins (seeding, the stand-in accounts migration) are refused in
 *  production, as in the application config. */
export function dbScriptSettings(env: NodeJS.ProcessEnv, name: string): DbScriptSettings {
  const production = env.NODE_ENV === 'production';
  const standins = env.STANDINS === 'true';
  if (production && standins) return { ok: false, message: 'STANDINS=true is refused in production' };
  if (!env.DATABASE_URL) return { ok: false, message: 'DATABASE_URL is required' };
  let u: URL;
  try {
    u = new URL(env.DATABASE_URL);
  } catch {
    return { ok: false, message: 'DATABASE_URL must be a mysql:// URL' };
  }
  if (u.protocol !== 'mysql:') return { ok: false, message: 'DATABASE_URL must be a mysql:// URL' };
  u.pathname = `/${name}`;
  const databaseUrl = u.toString();
  u.pathname = '/';
  return { ok: true, databaseUrl, serverUrl: u.toString(), seed: standins };
}
async function main(cmd: Command, name: string, settings: Extract<DbScriptSettings, { ok: true }>) {
  const server = createDb(settings.serverUrl);
  try {
    if (cmd === 'drop') {
      await server.raw(`DROP DATABASE IF EXISTS \`${name}\``);
      console.log(`dropped ${name}`);
    } else {
      if (cmd === 'create')
        await server.raw(
          `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
      const db = createDb(settings.databaseUrl);
      try {
        await db.migrate.latest(MIGRATIONS);
        if (cmd === 'create')
          // seedAccounts reads only `standins`.
          await seedAccounts(db, { standins: settings.seed } as Config);
        console.log(`${cmd}d ${name}`);
      } finally {
        await db.destroy();
      }
    }
  } finally {
    await server.destroy();
  }
}
if (isMainModule(process.argv[1], import.meta.url)) {
  const check = checkDbCommand(process.argv[2], process.argv[3]);
  if (!check.ok) {
    console.error(check.message);
    process.exit(2);
  }
  const settings = dbScriptSettings(process.env, check.name);
  if (!settings.ok) {
    console.error(settings.message);
    process.exit(2);
  }
  await main(check.cmd, check.name, settings);
}
