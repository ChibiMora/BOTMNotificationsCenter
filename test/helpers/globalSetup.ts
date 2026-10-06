import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { testConfig } from './db.js';
import { TEST_DB_DEFAULTS } from './testEnv.js';
const DB_SCRIPT = fileURLToPath(new URL('../../scripts/db.ts', import.meta.url));
/**
 * Ensure the DB_NAME database exists, is migrated and seeded (idempotent), then hold a MySQL named lock on it for the
 * whole run so a second DB project (or a second run) against the same database fails loudly instead of colliding.
 */
export default async function setup() {
  const env = { ...process.env, ...TEST_DB_DEFAULTS, STANDINS: 'true' };
  Object.assign(process.env, TEST_DB_DEFAULTS);
  const config = testConfig();
  // Lock on the server (the database may not exist yet) BEFORE `db create` migrates and re-seeds it. MySQL caps lock
  // names at 64 characters, so use a short prefix + sha1 of the database name.
  const serverUrl = new URL(config.databaseUrl);
  serverUrl.pathname = '/';
  const lock = `nc_tests:${createHash('sha1').update(config.dbName).digest('hex')}`;
  const conn = await mysql.createConnection(serverUrl.toString());
  let held = false;
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS got', [lock]);
    if (rows[0]?.got !== 1)
      throw new Error(
        `another test project or run is using database ${config.dbName}; run \`npm test\` (projects in sequence) or one --project at a time`,
      );
    execFileSync('npx', ['tsx', DB_SCRIPT, 'create', config.dbName], { env, stdio: 'inherit' });
    held = true;
  } finally {
    if (!held) await conn.end();
  }
  return async () => {
    try {
      await conn.query('SELECT RELEASE_LOCK(?)', [lock]);
    } finally {
      await conn.end();
    }
  };
}
