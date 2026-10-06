import { loadConfig } from '../src/config/index.js';
import { createWriterDb } from '../src/db/index.js';
import { seedAccounts } from './seedAccounts.js';
const config = loadConfig(process.env);
const db = createWriterDb(config);
try {
  console.log((await seedAccounts(db, config)) ? 'seeded 72 accounts' : 'STANDINS is not true; seed skipped');
} finally {
  await db.destroy();
}
