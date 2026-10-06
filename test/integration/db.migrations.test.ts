import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDb, migrationSource } from '../../src/db/index.js';
import { testConfig } from '../helpers/db.js';
import { TEST_DB_DEFAULTS } from '../helpers/testEnv.js';

const DB_SCRIPT = fileURLToPath(new URL('../../scripts/db.ts', import.meta.url));
const NAME = 'u10_ops_b_mig';
const env = { ...process.env, ...TEST_DB_DEFAULTS, STANDINS: 'true' };
const run = (cmd: string) => execFileSync('npx', ['tsx', DB_SCRIPT, cmd, NAME], { env, encoding: 'utf8' });
const urlFor = (name: string) => {
  const u = new URL(testConfig().databaseUrl);
  u.pathname = `/${name}`;
  return u.toString();
};

describe('migrations are recorded by extension-less name', () => {
  it('create records base names, migrate again is a no-op, a .js source accepts the same database', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'u10-mig-'));
    const db = createDb(urlFor(NAME));
    try {
      run('create');
      const names = (await db('knex_migrations').orderBy('id').select('name')).map(
        (r: any) => r.name as string,
      );
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(n).toMatch(/^\d{14}_[a-z_]+$/);
      expect(run('migrate')).toContain('migrated');
      expect(await db('knex_migrations').count({ n: '*' })).toEqual([{ n: names.length }]);
      // The built image ships dist/migrations/*.js (plus .d.ts / .map): same base names, other extension.
      for (const n of names) {
        writeFileSync(
          join(tmp, `${n}.js`),
          'export const up = async () => { throw new Error("must not run"); };\nexport const down = async () => {};\n',
        );
        writeFileSync(join(tmp, `${n}.d.ts`), 'export {};\n');
        writeFileSync(join(tmp, `${n}.js.map`), '{}\n');
      }
      const src = migrationSource(tmp);
      expect((await src.getMigrations([])).map((m) => src.getMigrationName(m))).toEqual(names);
      const [, pending] = await db.migrate.latest({ migrationSource: src });
      expect(pending).toEqual([]);
    } finally {
      await db.destroy();
      rmSync(tmp, { recursive: true, force: true });
      run('drop');
    }
  });
});
