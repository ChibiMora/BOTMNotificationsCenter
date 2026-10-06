// §10.3 scenario tests: CSV import end to end, and an import that dead-letters and is retried.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db.js';
import { scenario, content, DAY } from '../helpers/scenario.js';
import { dueSendTimer } from '../../src/scheduler/dueSend.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => resetDb(db));

const TOMORROW = '2026-10-05T14:30:00Z'; // the scenario clock starts at 2026-10-04T14:30:00Z
const CSV = 'accountID\n4\n5\n5\n999999\n6\n'; // 5 rows: 3 accepted, 1 duplicate, 1 unknown id
const LISTED = [4, 5, 6];

describe('scenario: CSV import', () => {
  it('accepts, reconciles, schedules for liveDate, then releases; a past liveDate is refused', async () => {
    const s = await scenario(db);

    // 1. Upload with duplicates and an unknown id, liveDate tomorrow -> 202.
    const up = await s.admin.upload({ ...content('Imported'), liveDate: TOMORROW }, CSV);
    expect(up.status).toBe(202);

    // 2. Worker runs; the report is completed with reconciled counts.
    await s.runWorker();
    const rep = await s.admin.getImport(up.body.id);
    expect(rep.status).toBe(200);
    expect(rep.body).toMatchObject({
      status: 'completed',
      totalRows: 5,
      accepted: 3,
      duplicatesIgnored: 1,
    });
    expect(rep.body.errors).toEqual([expect.objectContaining({ row: 4, accountId: 999999 })]);
    expect(rep.body.totalRows).toBe(rep.body.accepted + rep.body.duplicatesIgnored + rep.body.errors.length);

    // 3. Listed members see nothing yet.
    expect(await s.seenBy('Imported', LISTED)).toEqual([]);

    // 4. Past liveDate, due-send: exactly the listed members see it, with liveDate = the release time.
    s.clock.set('2026-10-05T14:31:00Z');
    const releasedAt = s.clock.now();
    await dueSendTimer(s.deps).run(s.deps);
    await s.runWorker();
    expect(await s.seenBy('Imported')).toEqual(LISTED);
    const items = await s.member(4);
    expect(items).toEqual([expect.objectContaining({ headline: 'Imported' })]);
    // Design: due-send sets sent_at = now, the real go-live instant; a member's liveDate is when the delivery went live.
    const liveAt = new Date(String(items[0]?.liveDate)).getTime();
    expect(liveAt).toBe(releasedAt.getTime());
    expect(liveAt).toBeGreaterThanOrEqual(new Date(TOMORROW).getTime());

    // 5. A past liveDate upload is refused with the explained 400.
    const past = await s.admin.upload({ ...content('Late'), liveDate: '2026-10-05T14:00:00Z' }, CSV);
    expect(past.status).toBe(400);
    expect(JSON.stringify(past.body)).toContain('liveDate must be in the future');
    await s.expectQueueIdle();
  });
});

describe('scenario: import failure and retry', () => {
  it('a run that fails mid-file dead-letters to failed, a new run completes, and no member gets two rows', async () => {
    // While `failing`, process_import throws right after its first chunk ([4, 5]) is written: a partial run.
    let failing = true;
    const s = await scenario(db, {
      config: { importChunk: 2 },
      handlers: (real) => ({
        ...real,
        process_import: (payload, ctx) =>
          real.process_import(payload, {
            ...ctx,
            heartbeat: async () => {
              await ctx.heartbeat();
              if (failing) throw new Error('injected failure after the first chunk');
            },
          }),
      }),
    });

    // 1. Upload; every attempt fails after chunk 1 until the job is dead-lettered (the clock passes each backoff).
    const up = await s.admin.upload({ ...content('Retried'), liveDate: TOMORROW }, CSV);
    expect(up.status).toBe(202);
    for (let i = 0; i < s.deps.config.jobMaxAttempts; i++) {
      await s.runWorker({ expectRetry: true });
      s.clock.advance(DAY / 24);
    }
    await s.runWorker();
    expect((await s.admin.getImport(up.body.id)).body.status).toBe('failed');
    expect(await db('jobs').where({ type: 'process_import' }).first('status', 'attempts')).toEqual({
      status: 'dead',
      attempts: s.deps.config.jobMaxAttempts,
    });

    // The first chunk's deliveries were written, scheduled (unsent) and invisible to members; the rest were not.
    const partial = await db('notification_deliveries').orderBy('account_id').select('account_id', 'sent_at');
    expect(partial).toEqual([
      { account_id: 4, sent_at: null },
      { account_id: 5, sent_at: null },
    ]);
    expect(await s.seenBy('Retried', LISTED)).toEqual([]);

    // 2. Admin starts a new run; the worker completes it and the report reconciles.
    failing = false;
    const run = await s.admin.rerun(up.body.id);
    expect(run.status).toBe(202);
    await s.runWorker();
    const rep = (await s.admin.getImport(up.body.id)).body;
    expect(rep).toMatchObject({ status: 'completed', totalRows: 5, accepted: 3, duplicatesIgnored: 1 });
    expect(rep.totalRows).toBe(rep.accepted + rep.duplicatesIgnored + rep.errors.length);

    // 3. Exactly one delivery row per listed member, and none for anyone else.
    const rows = (await db('notification_deliveries')
      .select('account_id')
      .count({ n: '*' })
      .groupBy('account_id')
      .orderBy('account_id')) as { account_id: number; n: number | string }[];
    expect(rows.map((r) => [Number(r.account_id), Number(r.n)])).toEqual(LISTED.map((id) => [id, 1]));

    // 4. Released: each listed member sees exactly one item.
    s.clock.set('2026-10-05T14:31:00Z');
    await dueSendTimer(s.deps).run(s.deps);
    await s.runWorker();
    for (const id of LISTED)
      expect(await s.member(id)).toEqual([expect.objectContaining({ headline: 'Retried' })]);
    expect(await s.seenBy('Retried')).toEqual(LISTED);
    await s.expectQueueIdle({ allowDead: ['process_import'] }); // the first run's dead-lettered job
  });
});

describe('scenario: CSV import, past liveDate', () => {
  // A focused check of the past-liveDate refusal: nothing is stored for a refused upload.
  it('refuses an upload whose liveDate is not in the future with the explained 400', async () => {
    const s = await scenario(db);
    const past = await s.admin.upload({ ...content('Late'), liveDate: '2026-10-04T14:00:00Z' }, CSV);
    expect(past.status).toBe(400);
    expect(JSON.stringify(past.body)).toContain('liveDate must be in the future');
    expect(await db('imports').count({ n: '*' }).first()).toEqual({ n: 0 });
    await s.expectQueueIdle();
  });
});
