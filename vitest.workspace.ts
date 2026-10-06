import { defineWorkspace } from 'vitest/config';
import { TEST_DB_DEFAULTS } from './test/helpers/testEnv.js';
// DB-touching projects run their files sequentially (fileParallelism: false). DB_NAME selects the database (one per
// worktree); unset DATABASE_URL / DB_NAME default to the compose server and `notification_center_test` (§10.4).
// integration and contract share that database, so they must not run at the same time: `npm test` runs them one
// after the other. A bare `vitest run` would start both; globalSetup takes a MySQL named lock per database and the
// second project fails loudly instead of colliding (vitest 2.1 has no option to serialise workspace projects).
const env = {
  STANDINS: 'true',
  ASSET_BASE_URL: 'https://assets.example.com',
  SITE_BASE_URL: 'https://www.example.com',
  ...TEST_DB_DEFAULTS,
};
const db = (name: string) => ({
  test: {
    name,
    include: [`test/${name}/**/*.test.ts`],
    globalSetup: ['test/helpers/globalSetup.ts'],
    env,
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
export default defineWorkspace([
  { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
  db('integration'),
  db('contract'),
]);
