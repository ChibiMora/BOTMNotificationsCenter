import { describe, it, expect } from 'vitest';
import { testApp } from '../helpers/app.js';
import { FixedClock } from '../helpers/clock.js';
import { systemClock } from '../../src/lib/clock.js';

describe('testApp helper', () => {
  it('opens its own pool when db is omitted and close() destroys it', async () => {
    const t = testApp();
    expect((await t.request.get('/readyz')).status).toBe(200);
    await t.close();
    await expect(t.deps.db.raw('select 1')).rejects.toThrow();
  });
  it('close() never destroys a db the test passed in', async () => {
    const own = testApp();
    const t = testApp({ db: own.deps.db });
    await t.close();
    expect(await own.deps.db.raw('select 1')).toBeDefined();
    await own.close();
  });
  it('clock is the FixedClock it created, or the override as given', async () => {
    const a = testApp();
    expect(a.clock).toBeInstanceOf(FixedClock);
    const b = testApp({ db: a.deps.db, clock: systemClock });
    expect(b.clock).toBe(systemClock);
    await a.close();
  });
});
