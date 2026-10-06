import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { up } from '../../migrations/20261001000000_standin_accounts.js';

const fakeKnex = (exists: boolean) => {
  const raw = vi.fn(async () => undefined);
  const knex = { schema: { hasTable: async () => exists }, raw } as any;
  return { knex, raw };
};
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
});
afterEach(() => {
  process.env = saved;
});
describe('stand-in accounts migration', () => {
  it('does nothing unless STANDINS=true when accounts already exists (production path)', async () => {
    delete process.env.STANDINS;
    const { knex, raw } = fakeKnex(true);
    await up(knex);
    expect(raw).not.toHaveBeenCalled();
  });
  it('without STANDINS=true and no accounts table, fails clearly instead of recording a no-op', async () => {
    for (const v of [undefined, 'false']) {
      if (v === undefined) delete process.env.STANDINS;
      else process.env.STANDINS = v;
      const { knex, raw } = fakeKnex(false);
      await expect(up(knex)).rejects.toThrow(
        'accounts table missing: set STANDINS=true for development/test; in production the table must already exist',
      );
      expect(raw).not.toHaveBeenCalled();
    }
  });
  it('gates on STANDINS alone: unrelated invalid env does not break it', async () => {
    process.env.STANDINS = 'true';
    process.env.NODE_ENV = 'test';
    process.env.PORT = 'not-a-number';
    const { knex, raw } = fakeKnex(false);
    await up(knex);
    expect(raw).toHaveBeenCalledTimes(1);
  });
  it('refuses STANDINS=true in production', async () => {
    process.env.STANDINS = 'true';
    process.env.NODE_ENV = 'production';
    await expect(up(fakeKnex(false).knex)).rejects.toThrow(/production/);
  });
  it('refuses if the accounts table already exists', async () => {
    process.env.STANDINS = 'true';
    process.env.NODE_ENV = 'test';
    await expect(up(fakeKnex(true).knex)).rejects.toThrow(/already exists/);
  });
});
