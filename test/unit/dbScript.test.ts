import { describe, expect, it } from 'vitest';
import { checkDbCommand, dbScriptSettings } from '../../scripts/db.js';

describe('db script settings (database settings only)', () => {
  const url = 'mysql://u:p@127.0.0.1:3306/ignored';
  it('needs only DATABASE_URL in production: no app settings, the argument overrides the database name', () => {
    expect(
      dbScriptSettings({ NODE_ENV: 'production', DATABASE_URL: url, DB_NAME: 'other' }, 'release_db'),
    ).toEqual({
      ok: true,
      databaseUrl: 'mysql://u:p@127.0.0.1:3306/release_db',
      serverUrl: 'mysql://u:p@127.0.0.1:3306/',
      seed: false,
    });
  });
  it('seeds stand-in accounts only when STANDINS=true outside production', () => {
    expect(dbScriptSettings({ DATABASE_URL: url, STANDINS: 'true' }, 'x')).toMatchObject({
      ok: true,
      seed: true,
    });
    expect(dbScriptSettings({ DATABASE_URL: url }, 'x')).toMatchObject({ ok: true, seed: false });
  });
  it('refuses stand-ins in production and a missing or invalid DATABASE_URL', () => {
    expect(dbScriptSettings({ NODE_ENV: 'production', DATABASE_URL: url, STANDINS: 'true' }, 'x')).toEqual({
      ok: false,
      message: 'STANDINS=true is refused in production',
    });
    expect(dbScriptSettings({}, 'x')).toEqual({ ok: false, message: 'DATABASE_URL is required' });
    expect(dbScriptSettings({ DATABASE_URL: 'not a url' }, 'x')).toEqual({
      ok: false,
      message: 'DATABASE_URL must be a mysql:// URL',
    });
  });
  it('prints a neutral usage line', () => {
    expect(checkDbCommand('nope', 'x')).toMatchObject({
      message: 'usage: db create|migrate|drop <name>   (name: [A-Za-z0-9_]+)',
    });
  });
});
