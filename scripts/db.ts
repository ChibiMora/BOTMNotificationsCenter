// npm run db -- create|migrate|drop <name>   — one database per worktree on the shared MySQL server.
// create = create + migrate + seed stand-in accounts (STANDINS=true); migrate = migrate only; drop = drop. Reserved schemas refused.
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config/index.js';
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
      message: 'usage: npm run db -- create|migrate|drop <name>   (name: [A-Za-z0-9_]+)',
    };
  if (RESERVED.includes(name.toLowerCase()))
    return { ok: false, reason: 'reserved', message: `refusing to ${cmd} reserved schema ${name}` };
  return { ok: true, cmd: cmd as Command, name };
}
async function main(cmd: Command, name: string) {
  const config = loadConfig({
    ASSET_BASE_URL: 'http://unused.invalid',
    SITE_BASE_URL: 'http://unused.invalid',
    ...process.env,
    DB_NAME: name,
  });
  const serverUrl = new URL(config.databaseUrl);
  serverUrl.pathname = '/';
  const server = createDb(serverUrl.toString());
  try {
    if (cmd === 'drop') {
      await server.raw(`DROP DATABASE IF EXISTS \`${name}\``);
      console.log(`dropped ${name}`);
    } else {
      if (cmd === 'create')
        await server.raw(
          `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
      const db = createDb(config.databaseUrl);
      try {
        await db.migrate.latest(MIGRATIONS);
        if (cmd === 'create') await seedAccounts(db, config);
        console.log(`${cmd}d ${name}`);
      } finally {
        await db.destroy();
      }
    }
  } finally {
    await server.destroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = checkDbCommand(process.argv[2], process.argv[3]);
  if (!check.ok) {
    console.error(check.message);
    process.exit(2);
  }
  await main(check.cmd, check.name);
}
