import { describe, it, expect, afterAll } from 'vitest';
import { testDb } from '../helpers/db.js';

const db = testDb();
afterAll(() => db.destroy());

const MARKER = 'SECRET-MARKER';
/** Everything a logger's err serializer could print: message, stack and every enumerable own property. */
const printable = (e: Error) => JSON.stringify({ ...e, message: e.message, stack: e.stack });
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('query unexpectedly succeeded');
    },
    (e: Error) => e,
  );

describe('createDb: failed queries never carry bound values (§5, content never logged)', () => {
  it('a failing insert rejects with an error whose message, stack and properties omit the bindings', async () => {
    const err = await failure(db('notifications').insert({ headline: MARKER }));
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('ER_NO_DEFAULT_FOR_FIELD');
    expect(err.message).not.toContain(MARKER);
    expect(String(err.stack)).not.toContain(MARKER);
    expect(printable(err)).not.toContain(MARKER);
  });
  it('the same holds inside a transaction', async () => {
    const err = await failure(db.transaction((trx) => trx('notifications').insert({ headline: MARKER })));
    expect(err).toBeInstanceOf(Error);
    expect(printable(err)).not.toContain(MARKER);
  });
});
